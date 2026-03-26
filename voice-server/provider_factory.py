"""
Factory functions for creating STT and TTS service instances based on provider config.

Centralizes provider instantiation so both voice_pipeline.py and twilio_pipeline.py
use a single calling convention.

Responsibilities:
- Create the correct STT service (ElevenLabs or Deepgram) based on config.stt_provider
- Create the correct TTS service (ElevenLabs or Deepgram) based on config.tts_provider
- Raise ValueError on invalid provider strings
"""

import aiohttp

from pipecat.services.elevenlabs.stt import ElevenLabsSTTService, ElevenLabsSTTSettings
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService, ElevenLabsTTSSettings
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService

from config import VoiceServerConfig


# ============================================================================
# FACTORY FUNCTIONS
# ============================================================================

def create_stt(config: VoiceServerConfig, session: aiohttp.ClientSession):
    """Create an STT service instance based on the active provider.

    Args:
        config: Voice server configuration with provider selection and API keys
        session: aiohttp session for HTTP-based STT services

    Returns:
        An STT service instance (ElevenLabsSTTService or DeepgramSTTService)
    """
    if config.stt_provider == "elevenlabs":
        return ElevenLabsSTTService(
            api_key=config.elevenlabs_api_key,
            aiohttp_session=session,
            settings=ElevenLabsSTTSettings(model=config.elevenlabs_stt_model),
        )

    if config.stt_provider == "deepgram":
        return DeepgramSTTService(
            api_key=config.deepgram_api_key,
            model=config.deepgram_stt_model,
        )

    raise ValueError(f'Unknown STT provider: "{config.stt_provider}"')


def create_tts(config: VoiceServerConfig, voice_id: str):
    """Create a TTS service instance based on the active provider.

    Args:
        config: Voice server configuration with provider selection and API keys
        voice_id: Voice identifier for the TTS service (provider-specific)

    Returns:
        A TTS service instance (ElevenLabsTTSService or DeepgramTTSService)
    """
    if config.tts_provider == "elevenlabs":
        return ElevenLabsTTSService(
            api_key=config.elevenlabs_api_key,
            settings=ElevenLabsTTSSettings(
                voice=voice_id,
                model=config.elevenlabs_tts_model,
            ),
        )

    if config.tts_provider == "deepgram":
        return DeepgramTTSService(
            api_key=config.deepgram_api_key,
            voice=voice_id,
        )

    raise ValueError(f'Unknown TTS provider: "{config.tts_provider}"')
