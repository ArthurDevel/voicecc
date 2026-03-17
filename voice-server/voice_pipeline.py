"""
Browser voice pipeline entry point for Pipecat runner.

Assembles the voice pipeline: WebRTC transport -> ElevenLabs STT -> stop phrase
detection -> user context aggregation -> Claude LLM -> narration -> ElevenLabs TTS
-> WebRTC output.

Can be run standalone via `python voice_pipeline.py` or imported from server.py
which starts it alongside the FastAPI server.

Responsibilities:
- Create SmallWebRTCTransport with audio I/O
- Wire STT -> LLM -> TTS pipeline with narration and stop phrase processors
- Load config and build system prompt
- Serve as the entry point for `pipecat.runner.run.main()`
- Expose `main` for import by server.py
"""

import aiohttp
import logging

from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import SmallWebRTCRunnerArguments
from pipecat.runner.run import main
from pipecat.services.elevenlabs.stt import ElevenLabsSTTService, ElevenLabsSTTSettings
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService, ElevenLabsTTSSettings
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from claude_llm_service import ClaudeLLMService, ClaudeLLMServiceConfig
from config import build_system_prompt, get_agent_voice_id, load_config
from narration_processor import NarrationProcessor
from stop_phrase_processor import StopPhraseProcessor

logger = logging.getLogger(__name__)


# ============================================================================
# MAIN HANDLERS
# ============================================================================

async def bot(runner_args: SmallWebRTCRunnerArguments):
    """Entry point for the Pipecat runner.

    Creates the full voice pipeline and runs it. Called automatically by
    Pipecat's runner when a WebRTC client connects.

    Args:
        runner_args: Runner arguments containing the WebRTC connection
    """
    config = load_config()

    # TODO: Accept agent_id from WebRTC signaling query params
    agent_id = None

    system_prompt = build_system_prompt(agent_id, "voice")
    voice_id = get_agent_voice_id(agent_id)

    # Transport
    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=16000,
            audio_out_sample_rate=24000,
        ),
    )

    # STT
    async with aiohttp.ClientSession() as session:
        stt = ElevenLabsSTTService(
            api_key=config.elevenlabs_api_key,
            aiohttp_session=session,
            settings=ElevenLabsSTTSettings(model=config.elevenlabs_stt_model),
        )

        # TTS
        tts = ElevenLabsTTSService(
            api_key=config.elevenlabs_api_key,
            settings=ElevenLabsTTSSettings(
                voice=voice_id,
                model=config.elevenlabs_tts_model,
            ),
        )

        # Claude LLM
        claude_config = ClaudeLLMServiceConfig(
            cwd=config.default_cwd,
            system_prompt=system_prompt,
            initial_prompt="The user just joined the call. Greet them briefly.",
        )
        claude_llm = ClaudeLLMService(config=claude_config)

        # Processors
        stop_phrase = StopPhraseProcessor()
        narration = NarrationProcessor()

        # Context aggregator -- Pipecat needs this to collect user speech into
        # LLM context frames. Claude SDK maintains its own history, so we just
        # need the aggregators to deliver user text to process_frame.
        context = LLMContext()
        context_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                vad_analyzer=SileroVADAnalyzer(),
            ),
        )

        # Pipeline:
        # transport.input -> STT -> stop_phrase -> user_aggregator -> LLM -> narration -> TTS -> transport.output
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
            params=PipelineParams(allow_interruptions=True),
        )

        # Send initial prompt once the pipeline is fully ready
        @task.event_handler("on_pipeline_started")
        async def on_pipeline_started(task_ref, *args):
            if claude_config.initial_prompt and not claude_llm._initial_prompt_sent:
                claude_llm._initial_prompt_sent = True
                await claude_llm._ensure_client()
                await claude_llm.push_frame(LLMFullResponseStartFrame())
                await claude_llm._send_to_claude(claude_config.initial_prompt)
                await claude_llm.push_frame(LLMFullResponseEndFrame())

        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    main()
