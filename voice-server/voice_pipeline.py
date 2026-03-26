"""
Browser voice pipeline entry point for Pipecat runner.

Assembles the voice pipeline: WebRTC transport -> STT -> stop phrase detection ->
user context aggregation -> Claude LLM -> narration -> TTS -> WebRTC output.
STT and TTS providers are selected via config (ElevenLabs or Deepgram).

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
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from claude_llm_service import ClaudeLLMService, ClaudeLLMServiceConfig
from config import build_system_prompt, get_agent_voice_id, load_config
from narration_processor import NarrationProcessor
from provider_factory import create_stt, create_tts
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

    # Extract agent_id from request_data sent by the browser client
    agent_id = None
    if runner_args.body and isinstance(runner_args.body, dict):
        agent_id = runner_args.body.get("agentId")
    logger.info(f"[voice] WebRTC session started, agent_id={agent_id}, body={runner_args.body}")

    system_prompt = build_system_prompt(agent_id, "voice")
    voice_id = get_agent_voice_id(agent_id, provider=config.tts_provider)
    logger.info(f"[voice] Using voice_id={voice_id} for provider={config.tts_provider}")

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

    # STT + TTS via provider factory
    async with aiohttp.ClientSession() as session:
        stt = create_stt(config, session)
        tts = create_tts(config, voice_id)

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
