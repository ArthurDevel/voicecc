"""
Text chat session manager for the Python voice server.

Port of chat-server.ts + claude-session.ts. Manages ClaudeSDKClient lifecycle
for text chat: lazy creation on first message, multi-turn reuse, inactivity
cleanup after 10 minutes.

Responsibilities:
- Create and reuse ClaudeSDKClient sessions keyed by device token
- Stream Claude responses as ChatSseEvent async generators
- Enforce max concurrent sessions
- Auto-cleanup inactive sessions on a 60-second timer
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

from config import build_system_prompt, load_config, DEFAULT_AGENTS_DIR

logger = logging.getLogger(__name__)

# ============================================================================
# CONSTANTS
# ============================================================================

INACTIVITY_TIMEOUT_SECONDS = 600  # 10 minutes
CLEANUP_INTERVAL_SECONDS = 60


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class ChatSseEvent:
    """SSE event sent to the client during text chat streaming.

    Attributes:
        type: Event type ("text_delta", "tool_start", "tool_end", "result", "error")
        content: Text content or error message
        tool_name: Tool name (only for tool_start events)
    """
    type: str
    content: str
    tool_name: str | None = None

    def to_dict(self) -> dict:
        """Serialize to a JSON-safe dict, omitting None fields."""
        d: dict = {"type": self.type, "content": self.content}
        if self.tool_name is not None:
            d["toolName"] = self.tool_name
        return d


@dataclass
class ChatSession:
    """Tracks an active text chat session.

    Attributes:
        session_key: Device token used as the session key
        client: Persistent ClaudeSDKClient for multi-turn chat
        agent_id: Optional agent identifier for agent-specific prompts
        streaming: Whether the session is currently streaming a response
        last_activity: Unix timestamp of last activity (for inactivity timeout)
    """
    session_key: str
    client: ClaudeSDKClient
    agent_id: str | None = None
    streaming: bool = False
    last_activity: float = field(default_factory=time.time)


# ============================================================================
# STATE
# ============================================================================

_active_sessions: dict[str, ChatSession] = {}
_cleanup_task: asyncio.Task | None = None


# ============================================================================
# MAIN HANDLERS
# ============================================================================

async def get_or_create_session(session_key: str, agent_id: str | None = None) -> ChatSession:
    """Get an existing chat session or create a new one.

    On first call for a session_key, creates a ClaudeSDKClient with the
    appropriate system prompt. Subsequent calls return the existing session.
    Enforces max concurrent sessions from config.

    Args:
        session_key: Device token to key the session on
        agent_id: Optional agent ID for agent-specific prompts

    Returns:
        The active ChatSession

    Raises:
        RuntimeError: If max concurrent sessions exceeded
    """
    existing = _active_sessions.get(session_key)
    if existing:
        existing.last_activity = time.time()
        return existing

    config = load_config()
    if len(_active_sessions) >= config.max_concurrent_sessions:
        raise RuntimeError(
            f"Max concurrent sessions ({config.max_concurrent_sessions}) reached"
        )

    system_prompt = build_system_prompt(agent_id, "text")

    # Determine working directory
    import os
    cwd = config.default_cwd
    if agent_id:
        agent_dir = os.path.join(DEFAULT_AGENTS_DIR, agent_id)
        if os.path.isdir(agent_dir):
            cwd = agent_dir

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        cwd=cwd,
        allowed_tools=[],
        permission_mode="bypassPermissions",
        include_partial_messages=True,
        max_thinking_tokens=10000,
    )

    client = ClaudeSDKClient(options=options)
    await client.connect()

    session = ChatSession(
        session_key=session_key,
        client=client,
        agent_id=agent_id,
    )
    _active_sessions[session_key] = session
    logger.info(f"[chat] Session created, key: {session_key}")

    return session


async def stream_message(session_key: str, text: str):
    """Send a user message and yield SSE events from Claude's response.

    Guards against concurrent streaming on the same session. Yields
    ChatSseEvent objects for each streaming event from Claude.

    Args:
        session_key: Device token identifying the session
        text: User message text

    Yields:
        ChatSseEvent objects for each streaming event

    Raises:
        RuntimeError: If no active session or already streaming
    """
    session = _active_sessions.get(session_key)
    if not session:
        raise RuntimeError("No active session")

    if session.streaming:
        raise RuntimeError("ALREADY_STREAMING")

    session.last_activity = time.time()
    session.streaming = True

    try:
        await session.client.query(text)

        async for msg in session.client.receive_response():
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock) and block.text:
                        yield ChatSseEvent(type="text_delta", content=block.text)
                    elif isinstance(block, ToolUseBlock):
                        yield ChatSseEvent(
                            type="tool_start", content="", tool_name=block.name
                        )

            elif isinstance(msg, ResultMessage):
                if msg.is_error:
                    yield ChatSseEvent(
                        type="error", content=msg.subtype or "Unknown error"
                    )
                break

        yield ChatSseEvent(type="result", content="")

    except Exception as e:
        logger.error(f"[chat] Stream error for {session_key}: {e}")
        yield ChatSseEvent(type="error", content=str(e))

    finally:
        session.streaming = False
        session.last_activity = time.time()


async def close_session(session_key: str) -> None:
    """Close a chat session, disconnecting the Claude client.

    Args:
        session_key: Device token identifying the session
    """
    session = _active_sessions.pop(session_key, None)
    if not session:
        return

    try:
        await session.client.disconnect()
    except Exception as e:
        logger.warning(f"[chat] Error disconnecting session {session_key}: {e}")

    logger.info(f"[chat] Session closed, key: {session_key}")


async def interrupt_session(session_key: str) -> bool:
    """Interrupt the current streaming response for a session.

    Args:
        session_key: Device token identifying the session

    Returns:
        True if a streaming session was interrupted, False otherwise
    """
    session = _active_sessions.get(session_key)
    if not session or not session.streaming:
        return False

    try:
        await session.client.interrupt()
    except Exception as e:
        logger.warning(f"[chat] Interrupt error for {session_key}: {e}")

    session.streaming = False
    session.last_activity = time.time()
    logger.info(f"[chat] Session interrupted, key: {session_key}")
    return True


def has_session(session_key: str) -> bool:
    """Check if a session exists for the given key.

    Args:
        session_key: Device token to check

    Returns:
        True if a session exists
    """
    return session_key in _active_sessions


async def cleanup_inactive() -> None:
    """Close sessions that have been inactive for 10+ minutes.

    Called on a periodic timer. Safe to call concurrently.
    """
    now = time.time()
    stale_keys = [
        key
        for key, session in _active_sessions.items()
        if now - session.last_activity > INACTIVITY_TIMEOUT_SECONDS
    ]

    for key in stale_keys:
        logger.info(f"[chat] Session timed out due to inactivity, key: {key}")
        await close_session(key)


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _cleanup_loop() -> None:
    """Background loop that runs cleanup_inactive every 60 seconds."""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            await cleanup_inactive()
        except Exception as e:
            logger.error(f"[chat] Cleanup error: {e}")


def start_cleanup_timer() -> None:
    """Start the background cleanup timer. Call once at server startup."""
    global _cleanup_task
    if _cleanup_task is None:
        _cleanup_task = asyncio.create_task(_cleanup_loop())
        logger.info("[chat] Inactivity cleanup timer started")


def stop_cleanup_timer() -> None:
    """Stop the background cleanup timer."""
    global _cleanup_task
    if _cleanup_task is not None:
        _cleanup_task.cancel()
        _cleanup_task = None
