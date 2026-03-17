"""
Twilio voice pipeline using FastAPIWebsocketTransport with TwilioFrameSerializer.

Handles inbound and outbound Twilio phone calls by wiring Pipecat components
for mulaw audio over WebSocket. Supports heartbeat session handoff where a
pre-existing Claude session is passed through to preserve context.

Responsibilities:
- Create a Pipecat pipeline with TwilioFrameSerializer for mulaw 8kHz audio
- Handle FastAPI WebSocket connections from Twilio media streams
- Extract Twilio metadata (stream_sid, call_sid) from the WebSocket "start" event
- Look up pending calls to retrieve pre-existing ClaudeSDKClient sessions
- Wire STT -> LLM -> TTS pipeline identical to browser pipeline
"""

import asyncio
import json
import logging
import os

import aiohttp
from fastapi import WebSocket

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.elevenlabs.stt import ElevenLabsSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from claude_llm_service import ClaudeLLMService, ClaudeLLMServiceConfig
from config import (
    DEFAULT_AGENTS_DIR,
    build_system_prompt,
    get_agent_voice_id,
    load_config,
)
from heartbeat import get_pending_client
from narration_processor import NarrationProcessor
from stop_phrase_processor import StopPhraseProcessor

logger = logging.getLogger(__name__)


# ============================================================================
# MAIN HANDLERS
# ============================================================================

async def handle_twilio_websocket(websocket: WebSocket, call_token: str) -> None:
    """Handle a Twilio media stream WebSocket connection.

    Accepts the WebSocket, waits for the Twilio "start" event to extract metadata,
    looks up any pending call config, then creates and runs the voice pipeline.

    Args:
        websocket: FastAPI WebSocket connection from Twilio
        call_token: Per-call UUID token from the URL path
    """
    await websocket.accept()

    config = load_config()

    # Wait for the Twilio "start" event to get stream metadata
    stream_sid = None
    call_sid = None

    try:
        # Read messages until we get the "start" event
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg.get("event") == "start":
                start_data = msg.get("start", {})
                stream_sid = start_data.get("streamSid")
                call_sid = start_data.get("callSid")
                logger.info(
                    f"[twilio] Stream started -- callSid: {call_sid}, "
                    f"streamSid: {stream_sid}"
                )
                break

            if msg.get("event") == "connected":
                # Initial connected event -- keep waiting for start
                continue

            # Unexpected event before start
            logger.warning(f"[twilio] Unexpected event before start: {msg.get('event')}")

    except Exception as e:
        logger.error(f"[twilio] Error waiting for start event: {e}")
        await websocket.close()
        return

    if not stream_sid:
        logger.error("[twilio] No stream_sid in start event")
        await websocket.close()
        return

    # Look up pending call for heartbeat handoff or API-initiated calls
    pending = get_pending_client(call_token)
    agent_id = None
    existing_client = None
    initial_prompt = None

    if pending:
        agent_id = pending.agent_id
        existing_client = pending.client  # May be None for API calls
        initial_prompt = pending.initial_prompt
        logger.info(
            f'[twilio] Using pending call for agent "{agent_id}", '
            f'has_client={existing_client is not None}'
        )

    # Build LLM config
    system_prompt = build_system_prompt(agent_id, "voice")
    cwd = os.path.join(DEFAULT_AGENTS_DIR, agent_id) if agent_id else config.default_cwd
    voice_id = get_agent_voice_id(agent_id)

    llm_config = ClaudeLLMServiceConfig(
        cwd=cwd,
        system_prompt=system_prompt,
        existing_client=existing_client,
        initial_prompt=initial_prompt,
    )

    # Create and run the pipeline
    try:
        await _run_twilio_pipeline(
            websocket=websocket,
            stream_sid=stream_sid,
            call_sid=call_sid or "",
            config=config,
            llm_config=llm_config,
            voice_id=voice_id,
        )
    except Exception as e:
        logger.error(f"[twilio] Pipeline error: {e}")
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _run_twilio_pipeline(
    websocket: WebSocket,
    stream_sid: str,
    call_sid: str,
    config,
    llm_config: ClaudeLLMServiceConfig,
    voice_id: str,
) -> None:
    """Create and run the Twilio voice pipeline.

    Assembles: transport.input -> STT -> stop_phrase -> user_aggregator
    -> claude_llm -> narration -> TTS -> transport.output

    Args:
        websocket: Active FastAPI WebSocket connection
        stream_sid: Twilio stream identifier
        call_sid: Twilio call SID
        config: Voice server configuration
        llm_config: Claude LLM service configuration
        voice_id: ElevenLabs voice ID
    """
    serializer = TwilioFrameSerializer(stream_sid=stream_sid, call_sid=call_sid)

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            vad_enabled=True,
            vad_audio_passthrough=True,
            serializer=serializer,
        ),
    )

    async with aiohttp.ClientSession() as session:
        # STT
        stt = ElevenLabsSTTService(
            api_key=config.elevenlabs_api_key,
            aiohttp_session=session,
            model=config.elevenlabs_stt_model,
        )

        # TTS
        tts = ElevenLabsTTSService(
            api_key=config.elevenlabs_api_key,
            voice_id=voice_id,
            model=config.elevenlabs_tts_model,
        )

        # Claude LLM
        claude_llm = ClaudeLLMService(config=llm_config)

        # Processors
        stop_phrase = StopPhraseProcessor()
        narration = NarrationProcessor()

        # Context aggregator
        context = OpenAILLMContext(messages=[], tools=[])
        context_aggregator = claude_llm.create_context_aggregator(context)

        # Pipeline
        pipeline = Pipeline(
            [
                transport.input(),
                stt,
                stop_phrase,
                context_aggregator.user(),
                claude_llm,
                narration,
                tts,
                transport.output(),
            ]
        )

        task = PipelineTask(
            pipeline,
            PipelineParams(allow_interruptions=True),
        )

        runner = PipelineRunner()
        await runner.run(task)
