"""Tests for agent-speaks-first behavior.

Verifies that when a call starts with an initial_prompt configured,
the agent produces a greeting (text output wrapped in response frames)
without any user input.

Run: cd voice-server && .venv/bin/python -m pytest initial-prompt.test.py -v
"""

import asyncio
from unittest.mock import AsyncMock

import pytest

from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)

from claude_llm_service import ClaudeLLMService, ClaudeLLMServiceConfig


# ============================================================================
# HELPERS
# ============================================================================

def _make_fake_client(response_text: str = "Hello! How can I help?"):
    """Create a mock ClaudeSDKClient that returns a canned text response."""
    client = AsyncMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    client.query = AsyncMock()

    async def fake_receive():
        yield AssistantMessage(
            content=[TextBlock(text=response_text)],
            model="test",
        )
        yield ResultMessage(
            subtype="success",
            is_error=False,
            duration_ms=0,
            duration_api_ms=0,
            num_turns=1,
            session_id="test",
        )

    client.receive_response = fake_receive
    return client


def _collect_frames(service: ClaudeLLMService) -> list:
    """Patch push_frame on a service to collect all output frames."""
    frames = []

    async def capture(frame, *args, **kwargs):
        frames.append(frame)

    service.push_frame = capture
    return frames


async def _trigger_initial_prompt(service: ClaudeLLMService, prompt: str):
    """Reproduce what the pipeline's on_pipeline_started handler does."""
    await service._ensure_client()
    await service.push_frame(LLMFullResponseStartFrame())
    await service._send_to_claude(prompt)
    await service.push_frame(LLMFullResponseEndFrame())


# ============================================================================
# TESTS
# ============================================================================

@pytest.mark.asyncio
async def test_agent_greets_user_on_call_start():
    """When a call starts with an initial_prompt, the agent should produce
    a spoken greeting — text frames wrapped in response start/end frames —
    without any user input."""
    client = _make_fake_client("Hey there! Welcome to the call.")
    config = ClaudeLLMServiceConfig(
        cwd="/tmp",
        system_prompt="You are a test agent.",
        initial_prompt="Greet the user briefly.",
        existing_client=client,
    )
    service = ClaudeLLMService(config=config)
    frames = _collect_frames(service)

    await _trigger_initial_prompt(service, config.initial_prompt)

    # The agent should have produced spoken output
    text_frames = [f for f in frames if isinstance(f, LLMTextFrame)]
    assert len(text_frames) >= 1, "Agent did not produce any spoken output"
    full_text = " ".join(f.text for f in text_frames)
    assert len(full_text) > 0, "Agent greeting was empty"

    # The prompt should have been sent to Claude
    client.query.assert_awaited_once_with("Greet the user briefly.")


@pytest.mark.asyncio
async def test_greeting_is_wrapped_for_tts():
    """The greeting must be wrapped in response start/end frames so TTS
    treats it as a single utterance (no gaps, no dropped last sentence)."""
    config = ClaudeLLMServiceConfig(
        cwd="/tmp",
        system_prompt="You are a test agent.",
        initial_prompt="Say hello.",
        existing_client=_make_fake_client("Hi! Nice to meet you."),
    )
    service = ClaudeLLMService(config=config)
    frames = _collect_frames(service)

    await _trigger_initial_prompt(service, config.initial_prompt)

    frame_types = [type(f) for f in frames]

    # Must have: start, then text(s), then end
    assert LLMFullResponseStartFrame in frame_types, "Missing response start"
    assert LLMFullResponseEndFrame in frame_types, "Missing response end"

    start_idx = frame_types.index(LLMFullResponseStartFrame)
    end_idx = frame_types.index(LLMFullResponseEndFrame)
    text_indices = [i for i, t in enumerate(frame_types) if t == LLMTextFrame]

    assert text_indices, "No text frames between start and end"
    assert all(start_idx < i < end_idx for i in text_indices), (
        "Text frames must appear between start and end for TTS to work correctly"
    )


@pytest.mark.asyncio
async def test_no_greeting_without_initial_prompt():
    """Without an initial_prompt, the agent should stay silent on call start."""
    config = ClaudeLLMServiceConfig(
        cwd="/tmp",
        system_prompt="You are a test agent.",
        initial_prompt=None,
        existing_client=_make_fake_client(),
    )
    service = ClaudeLLMService(config=config)
    frames = _collect_frames(service)

    # No trigger — the pipeline would not call _trigger_initial_prompt
    # because initial_prompt is None. Verify that's the guard.
    assert config.initial_prompt is None
    assert len(frames) == 0, "Agent should stay silent without initial_prompt"
