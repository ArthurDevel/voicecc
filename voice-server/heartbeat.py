"""
Heartbeat scheduler for agent check-ins, ported from heartbeat.ts.

Creates a persistent Claude Code session per heartbeat check so the agent can
execute whatever HEARTBEAT.md instructs. When a heartbeat determines the user
should be contacted, initiates an outbound Twilio call and hands the live Claude
session to the voice pipeline so it retains full context.

Responsibilities:
- Start/stop a 60-second asyncio interval that checks all enabled agents
- Track per-agent check intervals and concurrent-check guards
- Create persistent Claude sessions with full tool access
- Parse JSON heartbeat responses and initiate outbound calls
- Store live Claude sessions in pending_calls for voice call handoff
- 60-second cleanup timer for unanswered calls
- Expose last heartbeat results for the API
"""

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from uuid import uuid4

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient, AssistantMessage, ResultMessage, TextBlock

from config import (
    Agent,
    VoiceServerConfig,
    build_system_prompt,
    list_agents,
    load_agent,
    DEFAULT_AGENTS_DIR,
    PROJECT_ROOT,
)

logger = logging.getLogger(__name__)

# ============================================================================
# CONSTANTS
# ============================================================================

# Global check interval (60 seconds)
CHECK_INTERVAL_S = 60

# Default max time for a single heartbeat Claude session (5 minutes)
DEFAULT_HEARTBEAT_TIMEOUT_S = 5 * 60

# Cleanup timer for unanswered pending calls (60 seconds)
PENDING_CALL_TIMEOUT_S = 60

# Heartbeat prompt sent to the Claude session
_HEARTBEAT_PROMPT_PATH = os.path.join(PROJECT_ROOT, "init", "defaults", "system-heartbeat.md")


def _load_heartbeat_prompt() -> str:
    """Read the heartbeat prompt from disk."""
    with open(_HEARTBEAT_PROMPT_PATH, "r", encoding="utf-8") as f:
        return f.read().strip()


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class HeartbeatResult:
    """Result of a single agent heartbeat check."""
    agent_id: str
    should_call: bool
    reason: str
    timestamp: float


@dataclass
class PendingCall:
    """A pending outbound call waiting for Twilio to connect."""
    token: str
    agent_id: str
    client: ClaudeSDKClient
    initial_prompt: str | None
    created_at: float


# ============================================================================
# STATE
# ============================================================================

# Asyncio task for the interval loop
_interval_task: asyncio.Task | None = None

# Last heartbeat result per agent
_last_results: dict[str, HeartbeatResult] = {}

# Last check timestamp per agent (for interval tracking)
_last_check_times: dict[str, float] = {}

# Currently running agent IDs (concurrent guard)
_in_flight_checks: set[str] = set()

# Pending calls keyed by token, waiting for Twilio WebSocket connection
_pending_calls: dict[str, PendingCall] = {}

# Reference to config (set on start)
_config: VoiceServerConfig | None = None

# Getter for tunnel URL (set on start, imported from server module)
_get_tunnel_url = None


# ============================================================================
# MAIN HANDLERS
# ============================================================================

def start_heartbeat(config: VoiceServerConfig, get_tunnel_url_fn) -> None:
    """Start the heartbeat scheduler.

    Runs _check_all_agents every 60 seconds via an asyncio task.

    Args:
        config: Voice server configuration with Twilio credentials
        get_tunnel_url_fn: Callable that returns the current tunnel URL
    """
    global _interval_task, _config, _get_tunnel_url

    if _interval_task is not None:
        return

    _config = config
    _get_tunnel_url = get_tunnel_url_fn

    _interval_task = asyncio.create_task(_interval_loop())
    logger.info("[heartbeat] scheduler started (60s interval)")


def stop_heartbeat() -> None:
    """Stop the heartbeat scheduler. Cancels the asyncio interval task."""
    global _interval_task

    if _interval_task is not None:
        _interval_task.cancel()
        _interval_task = None
        logger.info("[heartbeat] scheduler stopped")


def get_heartbeat_status() -> dict[str, dict]:
    """Get the last heartbeat result per agent.

    Returns:
        Dict of agent_id -> serialized HeartbeatResult
    """
    return {
        agent_id: {
            "agent_id": r.agent_id,
            "should_call": r.should_call,
            "reason": r.reason,
            "timestamp": r.timestamp,
        }
        for agent_id, r in _last_results.items()
    }


def get_pending_client(token: str) -> PendingCall | None:
    """Retrieve and remove a pending call by token.

    Called when the Twilio WebSocket connects to hand off the live Claude session.

    Args:
        token: The call token

    Returns:
        PendingCall if found, None otherwise
    """
    return _pending_calls.pop(token, None)


def register_pending_call(token: str, agent_id: str, initial_prompt: str | None = None) -> None:
    """Register a pending call without a pre-existing Claude client.

    Used by the /register-call endpoint for API-initiated calls (e.g. "Call Me").

    Args:
        token: Unique call token
        agent_id: Agent identifier
        initial_prompt: Optional initial prompt for the agent
    """
    # No Claude client -- the pipeline will create a fresh one
    _pending_calls[token] = PendingCall(
        token=token,
        agent_id=agent_id,
        client=None,  # type: ignore[arg-type]
        initial_prompt=initial_prompt,
        created_at=time.time(),
    )


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _interval_loop() -> None:
    """Asyncio loop that runs _check_all_agents every CHECK_INTERVAL_S."""
    while True:
        try:
            await _check_all_agents()
        except Exception as e:
            logger.error(f"[heartbeat] check_all_agents error: {e}")
        await asyncio.sleep(CHECK_INTERVAL_S)


async def _check_all_agents() -> None:
    """Check all enabled agents and spawn heartbeat sessions for those that are due."""
    if not _config:
        return

    agents = list_agents(_config.agents_dir)
    if not agents:
        return

    now = time.time()

    for agent in agents:
        # Skip if interval has not elapsed
        last_check = _last_check_times.get(agent.id, 0)
        interval_s = agent.config.heartbeat_interval_minutes * 60
        if now - last_check < interval_s:
            continue

        # Skip if already checking this agent
        if agent.id in _in_flight_checks:
            continue

        # Fire-and-forget the check
        asyncio.create_task(_check_single_agent_wrapper(agent))


async def _check_single_agent_wrapper(agent: Agent) -> None:
    """Wrapper for check_single_agent that handles errors and in-flight tracking."""
    try:
        await check_single_agent(agent)
    except Exception as e:
        logger.error(f'[heartbeat] check failed for agent "{agent.id}": {e}')


async def check_single_agent(agent: Agent) -> HeartbeatResult:
    """Run a heartbeat check for a single agent using a persistent Claude session.

    If the check determines shouldCall, keeps the session alive and passes it
    to the outbound call so the voice session continues with full context.

    Args:
        agent: Full agent data with SOUL.md, MEMORY.md, HEARTBEAT.md

    Returns:
        HeartbeatResult with the check outcome
    """
    _in_flight_checks.add(agent.id)
    _last_check_times[agent.id] = time.time()

    client: ClaudeSDKClient | None = None

    try:
        timeout_s = (agent.config.heartbeat_timeout_minutes or 5) * 60 or DEFAULT_HEARTBEAT_TIMEOUT_S
        result, client = await _run_heartbeat_session(agent, timeout_s)
        _last_results[agent.id] = result

        logger.info(
            f'[heartbeat] agent "{agent.id}": shouldCall={result.should_call}, '
            f'reason="{result.reason}"'
        )

        if result.should_call:
            try:
                await initiate_agent_call(agent, client)
                client = None  # Don't close -- voice session owns it now
            except Exception as e:
                logger.error(f'[heartbeat] failed to call agent "{agent.id}": {e}')

        return result
    finally:
        # Close the session if we still own it
        if client:
            try:
                await client.disconnect()
            except Exception:
                pass
        _in_flight_checks.discard(agent.id)


async def _run_heartbeat_session(
    agent: Agent, timeout_s: float
) -> tuple[HeartbeatResult, ClaudeSDKClient]:
    """Run a heartbeat check using a persistent Claude session.

    Creates the session with the agent's full context, sends the heartbeat prompt,
    and parses the JSON response.

    Args:
        agent: Full agent data
        timeout_s: Maximum time for the session in seconds

    Returns:
        Tuple of (HeartbeatResult, live ClaudeSDKClient)
    """
    agent_dir = os.path.join(DEFAULT_AGENTS_DIR, agent.id)
    system_prompt = build_system_prompt(agent.id, "voice")

    options = ClaudeAgentOptions(
        system_prompt=system_prompt,
        cwd=agent_dir,
        allowed_tools=[],
        permission_mode="bypassPermissions",
        include_partial_messages=True,
        max_thinking_tokens=10000,
    )
    client = ClaudeSDKClient(options=options)
    await client.connect()

    timed_out = False

    async def _timeout_guard():
        nonlocal timed_out
        await asyncio.sleep(timeout_s)
        timed_out = True
        try:
            await client.interrupt()
        except Exception:
            pass

    timeout_task = asyncio.create_task(_timeout_guard())

    try:
        heartbeat_prompt = _load_heartbeat_prompt()
        response_text = ""

        await client.query(heartbeat_prompt)

        async for msg in client.receive_response():
            if isinstance(msg, AssistantMessage):
                for block in msg.content:
                    if isinstance(block, TextBlock) and block.text:
                        response_text += block.text
            elif isinstance(msg, ResultMessage):
                break

        if timed_out:
            logger.error(f'[heartbeat] session timed out for agent "{agent.id}"')
            return _fail_safe_result(agent.id), client

        if not response_text:
            logger.error(f'[heartbeat] no response text for agent "{agent.id}"')
            return _fail_safe_result(agent.id), client

        result = _parse_heartbeat_response(agent.id, response_text)
        return result, client

    except Exception as e:
        if timed_out:
            logger.error(f'[heartbeat] session timed out for agent "{agent.id}"')
        else:
            logger.error(f'[heartbeat] session error for agent "{agent.id}": {e}')
        return _fail_safe_result(agent.id), client

    finally:
        timeout_task.cancel()


async def initiate_agent_call(agent: Agent, client: ClaudeSDKClient) -> str:
    """Initiate an outbound Twilio call for an agent.

    Stores the live client in pending_calls, places the outbound call via Twilio
    REST API, and sets a 60-second cleanup timer.

    Args:
        agent: Full agent data
        client: Live Claude session to hand off to the voice pipeline

    Returns:
        The Twilio call SID
    """
    if not _config:
        raise RuntimeError("Heartbeat not started -- no config")

    tunnel_url = _get_tunnel_url() if _get_tunnel_url else None
    if not tunnel_url:
        raise RuntimeError("Tunnel is not running. Cannot place outbound call.")

    if not _config.twilio_account_sid or not _config.twilio_auth_token:
        raise RuntimeError("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set")

    if not _config.user_phone_number:
        raise RuntimeError("USER_PHONE_NUMBER must be set in Settings > General")

    token = str(uuid4())

    # Store the pending call with the live client
    pending = PendingCall(
        token=token,
        agent_id=agent.id,
        client=client,
        initial_prompt="The user just answered your call. Greet them and briefly explain why you're calling.",
        created_at=time.time(),
    )
    _pending_calls[token] = pending

    # Schedule cleanup for unanswered calls
    asyncio.create_task(_cleanup_pending_call(token))

    # Get from number via Twilio API
    from twilio.rest import Client as TwilioClient

    twilio_client = TwilioClient(_config.twilio_account_sid, _config.twilio_auth_token)
    numbers = twilio_client.incoming_phone_numbers.list(limit=1)
    if not numbers:
        raise RuntimeError("No Twilio phone numbers found on the account")
    from_number = numbers[0].phone_number

    # Build TwiML with WebSocket stream URL
    tunnel_host = tunnel_url.replace("https://", "").replace("http://", "")
    twiml = (
        f'<Response><Connect>'
        f'<Stream url="wss://{tunnel_host}/media/{token}?agentId={agent.id}" />'
        f'</Connect></Response>'
    )

    call = twilio_client.calls.create(
        to=_config.user_phone_number,
        from_=from_number,
        twiml=twiml,
    )

    logger.info(
        f"[heartbeat] outbound call placed to {_config.user_phone_number} "
        f"(callSid={call.sid})"
    )
    return call.sid


async def _cleanup_pending_call(token: str) -> None:
    """Clean up a pending call after PENDING_CALL_TIMEOUT_S if not claimed.

    Args:
        token: The pending call token
    """
    await asyncio.sleep(PENDING_CALL_TIMEOUT_S)

    pending = _pending_calls.pop(token, None)
    if pending and pending.client:
        logger.info(f"[heartbeat] cleaning up unanswered pending call: {token}")
        try:
            await pending.client.disconnect()
        except Exception:
            pass


def _parse_heartbeat_response(agent_id: str, text: str) -> HeartbeatResult:
    """Parse a heartbeat JSON response string into a HeartbeatResult.

    Expects a JSON object with shouldCall (boolean) and reason (string).

    Args:
        agent_id: Agent identifier
        text: Raw text from the assistant response

    Returns:
        Parsed HeartbeatResult
    """
    try:
        match = re.search(r'\{[\s\S]*"shouldCall"[\s\S]*\}', text)
        if not match:
            logger.error(
                f'[heartbeat] no JSON found in response for agent "{agent_id}": {text}'
            )
            return _fail_safe_result(agent_id)

        parsed = json.loads(match.group(0))
        return HeartbeatResult(
            agent_id=agent_id,
            should_call=bool(parsed.get("shouldCall", False)),
            reason=str(parsed.get("reason", "")),
            timestamp=time.time(),
        )
    except (json.JSONDecodeError, Exception) as e:
        logger.error(f'[heartbeat] JSON parse error for agent "{agent_id}": {e}')
        return _fail_safe_result(agent_id)


def _fail_safe_result(agent_id: str) -> HeartbeatResult:
    """Create a fail-safe HeartbeatResult that does not trigger a call.

    Args:
        agent_id: Agent identifier

    Returns:
        HeartbeatResult with should_call=False
    """
    return HeartbeatResult(
        agent_id=agent_id,
        should_call=False,
        reason="heartbeat check failed or timed out",
        timestamp=time.time(),
    )
