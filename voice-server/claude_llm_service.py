"""
Custom Pipecat LLMService wrapping the Python Claude Agent SDK (ClaudeSDKClient).

Uses ClaudeSDKClient for persistent multi-turn voice sessions with full tool use.
Does NOT use Pipecat's built-in context accumulation -- the Claude session maintains
its own conversation history internally.

Responsibilities:
- Override process_frame to handle LLM context frames from Pipecat aggregators
- Extract only the last user message from Pipecat context (SDK tracks history)
- Clear Pipecat context after each turn to prevent unbounded memory growth
- Support existing_client for heartbeat session handoff
- Support initial_prompt for agent-speaks-first flows
"""

import asyncio
import logging
from dataclasses import dataclass

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    FunctionCallsStartedFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesFrame,
    LLMTextFrame,
    StartFrame,
    TextFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.openai_llm_context import (
    OpenAILLMContext,
    OpenAILLMContextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService

logger = logging.getLogger(__name__)


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class ClaudeLLMServiceConfig:
    """Configuration for ClaudeLLMService.

    Args:
        cwd: Working directory for the Claude Code session
        system_prompt: System prompt for voice mode
        allowed_tools: Tool allowlist (empty list = all tools allowed)
        initial_prompt: Optional first message so the agent speaks first
        existing_client: Pre-existing ClaudeSDKClient (e.g. from heartbeat handoff)
    """
    cwd: str
    system_prompt: str
    allowed_tools: list[str] | None = None
    initial_prompt: str | None = None
    existing_client: ClaudeSDKClient | None = None


# ============================================================================
# MAIN HANDLERS
# ============================================================================

class ClaudeLLMService(LLMService):
    """Pipecat LLMService that wraps ClaudeSDKClient for voice conversations.

    Intercepts LLM context frames from the user aggregator, extracts the last
    user message, sends it to Claude via the SDK, and pushes text frames
    downstream for TTS.
    """

    def __init__(self, config: ClaudeLLMServiceConfig, **kwargs):
        super().__init__(**kwargs)
        self._config = config
        self._client: ClaudeSDKClient | None = config.existing_client
        self._connected = config.existing_client is not None
        self._initial_prompt_sent = False
        self._processing = False
        self._current_task: asyncio.Task | None = None

        # Initialize LLMSettings fields — Claude SDK manages these internally,
        # so we set them all to None (unsupported).
        self._settings.model = None
        self._settings.system_instruction = None
        self._settings.temperature = None
        self._settings.max_tokens = None
        self._settings.top_p = None
        self._settings.top_k = None
        self._settings.frequency_penalty = None
        self._settings.presence_penalty = None
        self._settings.seed = None
        self._settings.filter_incomplete_user_turns = None
        self._settings.user_turn_completion_config = None

    async def start(self, frame: StartFrame):
        """Handle pipeline start."""
        await super().start(frame)

    async def stop(self, frame: EndFrame):
        """Handle pipeline stop. Disconnects the Claude session."""
        await self.close()
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame):
        """Handle pipeline cancel. Disconnects the Claude session."""
        await self.close()
        await super().cancel(frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process incoming frames.

        Handles context frames from Pipecat's aggregators by extracting the last
        user message and sending it to Claude. All other frames pass through.

        Args:
            frame: The incoming frame
            direction: Frame direction (upstream/downstream)
        """
        await super().process_frame(frame, direction)

        context = None
        if isinstance(frame, OpenAILLMContextFrame):
            context = frame.context
        elif isinstance(frame, LLMContextFrame):
            context = frame.context
        elif isinstance(frame, LLMMessagesFrame):
            context = OpenAILLMContext.from_messages(frame.messages)
        elif isinstance(frame, InterruptionFrame):
            await self.interrupt()
            await self.push_frame(frame, direction)
            return
        else:
            await self.push_frame(frame, direction)
            return

        if context:
            # Extract the last user message text from the Pipecat context
            user_text = _extract_last_user_message(context)
            if not user_text:
                logger.warning("[claude-llm] No user message found in context")
                return

            # Clear Pipecat context to prevent unbounded growth
            # (Claude SDK maintains its own conversation history)
            if isinstance(context, OpenAILLMContext):
                context.set_messages([])
            elif isinstance(context, LLMContext):
                context.messages.clear()

            # Cancel any in-flight query before starting a new one
            await self._cancel_current_task()

            await self._ensure_client()

            async def _run_query():
                try:
                    await self.push_frame(LLMFullResponseStartFrame())
                    await self.start_processing_metrics()
                    await self._send_to_claude(user_text)
                except asyncio.CancelledError:
                    logger.info("[claude-llm] Query cancelled by new input")
                except Exception as e:
                    logger.error(f"[claude-llm] Error during Claude query: {e}")
                    await self.push_error(error_msg=f"Claude query error: {e}", exception=e)
                finally:
                    await self.stop_processing_metrics()
                    await self.push_frame(LLMFullResponseEndFrame())

            self._current_task = asyncio.create_task(_run_query())
            await self._current_task

    async def _cancel_current_task(self) -> None:
        """Cancel the in-flight query task if one is running."""
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()
            try:
                await self._current_task
            except (asyncio.CancelledError, Exception):
                pass
            self._current_task = None

    async def interrupt(self) -> None:
        """Interrupt the current Claude response and cancel the query task."""
        await self._cancel_current_task()
        if self._client and self._connected:
            try:
                await self._client.interrupt()
            except Exception as e:
                logger.warning(f"[claude-llm] Interrupt error: {e}")

    async def close(self) -> None:
        """Disconnect the Claude session."""
        if self._client and self._connected:
            try:
                await self._client.disconnect()
            except Exception as e:
                logger.warning(f"[claude-llm] Disconnect error: {e}")
            finally:
                self._connected = False
                self._client = None

    # ============================================================================
    # HELPER FUNCTIONS
    # ============================================================================

    async def _ensure_client(self) -> None:
        """Create and connect ClaudeSDKClient if not already connected.

        Uses existing_client if provided in config, otherwise creates a new one.
        """
        if self._client and self._connected:
            return

        if not self._client:
            options = ClaudeAgentOptions(
                system_prompt=self._config.system_prompt,
                cwd=self._config.cwd,
                allowed_tools=self._config.allowed_tools or [],
                permission_mode="bypassPermissions",
                include_partial_messages=True,
                max_thinking_tokens=0,
            )
            self._client = ClaudeSDKClient(options=options)

        await self._client.connect()
        self._connected = True
        logger.info("[claude-llm] Claude session connected")

    async def _send_to_claude(self, text: str) -> None:
        """Send a user message to Claude and push response text frames downstream.

        Iterates over the streaming response, extracting text deltas and tool use
        events. Text is pushed as LLMTextFrame for TTS. Tool starts are pushed as
        FunctionCallsStartedFrame for the narration processor.

        Args:
            text: The user message to send
        """
        if not self._client:
            raise RuntimeError("Claude client not connected")

        self._processing = True
        has_streamed = False

        try:
            await self._client.query(text)

            async for msg in self._client.receive_response():
                if isinstance(msg, AssistantMessage):
                    # Process content blocks from the assistant message
                    for block in msg.content:
                        if isinstance(block, TextBlock) and block.text:
                            if not has_streamed:
                                has_streamed = True
                                await self.start_ttfb_metrics()
                                await self.stop_ttfb_metrics()
                            await self.push_frame(LLMTextFrame(block.text))
                        elif isinstance(block, ToolUseBlock):
                            logger.info(f"[claude-llm] Tool use: {block.name}")
                            # Push a text frame announcing tool use for narration
                            await self.push_frame(TextFrame(f"__tool_start:{block.name}"))

                elif isinstance(msg, ResultMessage):
                    if msg.is_error:
                        logger.error(f"[claude-llm] Result error: {msg.subtype}")
                    else:
                        logger.info("[claude-llm] Turn complete")
                    break

        finally:
            self._processing = False


def _extract_last_user_message(context: OpenAILLMContext | LLMContext | object) -> str | None:
    """Extract the last user message text from a Pipecat LLM context.

    The context contains OpenAI-format messages. We find the last message
    with role="user" and extract its text content.

    Args:
        context: Pipecat LLM context (OpenAILLMContext, LLMContext, or other)

    Returns:
        The last user message text, or None if no user message found
    """
    if isinstance(context, OpenAILLMContext):
        messages = context.get_messages()
    elif isinstance(context, LLMContext):
        messages = context.messages
    else:
        messages = getattr(context, "messages", [])

    if not messages:
        return None

    # Walk backwards to find the last user message
    for msg in reversed(messages):
        msg_dict = msg if isinstance(msg, dict) else vars(msg) if hasattr(msg, "__dict__") else {}
        if msg_dict.get("role") == "user":
            content = msg_dict.get("content", "")
            if isinstance(content, str):
                return content.strip() or None
            # Content might be a list of content blocks
            if isinstance(content, list):
                texts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        texts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        texts.append(block)
                joined = " ".join(texts).strip()
                return joined or None

    return None
