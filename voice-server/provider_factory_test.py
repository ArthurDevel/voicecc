"""Test provider factory returns correct service classes per provider setting.

Verifies that create_stt and create_tts return the right Pipecat service
instances and raise ValueError on invalid provider strings.

Run: cd voice-server && python -m pytest provider_factory_test.py -v
"""

from unittest.mock import MagicMock

import pytest

from pipecat.services.elevenlabs.stt import ElevenLabsSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService

from config import VoiceServerConfig
from provider_factory import create_stt, create_tts


# ============================================================================
# FIXTURES
# ============================================================================

def _make_config(**overrides) -> VoiceServerConfig:
    """Create a VoiceServerConfig with sensible defaults, allowing overrides."""
    defaults = dict(
        webrtc_port=7860,
        api_port=7861,
        tunnel_url=None,
        stt_provider="elevenlabs",
        tts_provider="elevenlabs",
        elevenlabs_api_key="ek_test",
        elevenlabs_voice_id="voice_test",
        elevenlabs_tts_model="eleven_turbo_v2_5",
        elevenlabs_stt_model="scribe_v1",
        deepgram_api_key="dg_test",
        deepgram_stt_model="nova-2",
        deepgram_tts_voice="aura-asteria-en",
        agents_dir="/tmp/agents",
        default_cwd="/tmp",
        project_root="/tmp/project",
        twilio_account_sid="",
        twilio_auth_token="",
        twilio_phone_number="",
        user_phone_number="",
        max_concurrent_sessions=2,
    )
    defaults.update(overrides)
    return VoiceServerConfig(**defaults)


# ============================================================================
# TESTS: create_stt
# ============================================================================

def test_create_stt_elevenlabs():
    """create_stt returns ElevenLabsSTTService when stt_provider is 'elevenlabs'."""
    config = _make_config(stt_provider="elevenlabs")
    session = MagicMock()
    stt = create_stt(config, session)
    assert isinstance(stt, ElevenLabsSTTService)


def test_create_stt_deepgram():
    """create_stt returns DeepgramSTTService when stt_provider is 'deepgram'."""
    config = _make_config(stt_provider="deepgram")
    session = MagicMock()
    stt = create_stt(config, session)
    assert isinstance(stt, DeepgramSTTService)


def test_create_stt_invalid_raises():
    """create_stt raises ValueError on unknown provider."""
    config = _make_config(stt_provider="whisper")
    session = MagicMock()
    with pytest.raises(ValueError, match="Unknown STT provider"):
        create_stt(config, session)


# ============================================================================
# TESTS: create_tts
# ============================================================================

def test_create_tts_elevenlabs():
    """create_tts returns ElevenLabsTTSService when tts_provider is 'elevenlabs'."""
    config = _make_config(tts_provider="elevenlabs")
    tts = create_tts(config, "voice_test")
    assert isinstance(tts, ElevenLabsTTSService)


def test_create_tts_deepgram():
    """create_tts returns DeepgramTTSService when tts_provider is 'deepgram'."""
    config = _make_config(tts_provider="deepgram")
    tts = create_tts(config, "aura-asteria-en")
    assert isinstance(tts, DeepgramTTSService)


def test_create_tts_invalid_raises():
    """create_tts raises ValueError on unknown provider."""
    config = _make_config(tts_provider="google")
    with pytest.raises(ValueError, match="Unknown TTS provider"):
        create_tts(config, "voice_test")
