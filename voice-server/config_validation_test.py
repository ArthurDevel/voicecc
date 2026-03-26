"""Test load_config() API key validation for each provider combination.

Verifies that load_config() requires API keys only for active providers and
rejects invalid provider strings.

Run: cd voice-server && python -m pytest config_validation_test.py -v
"""

from pathlib import Path

import pytest

from config import load_config


# ============================================================================
# FIXTURES
# ============================================================================

@pytest.fixture(autouse=True)
def _isolated_env(tmp_path, monkeypatch):
    """Point VOICECC_DIR at a temp dir and clean relevant env vars."""
    monkeypatch.setenv("VOICECC_DIR", str(tmp_path))
    for var in (
        "ELEVENLABS_API_KEY", "DEEPGRAM_API_KEY",
        "STT_PROVIDER", "TTS_PROVIDER",
    ):
        monkeypatch.delenv(var, raising=False)


def _write_env(tmp_path: Path, values: dict[str, str]) -> None:
    """Write a .env file from a dict of key-value pairs."""
    env_file = tmp_path / ".env"
    env_file.write_text("\n".join(f"{k}={v}" for k, v in values.items()) + "\n")


# ============================================================================
# TESTS: VALID CONFIGURATIONS
# ============================================================================

def test_elevenlabs_only_succeeds_with_elevenlabs_key(tmp_path):
    """Default providers (elevenlabs) succeed when only ELEVENLABS_API_KEY is set."""
    _write_env(tmp_path, {"ELEVENLABS_API_KEY": "ek_test"})
    config = load_config()
    assert config.stt_provider == "elevenlabs"
    assert config.tts_provider == "elevenlabs"
    assert config.elevenlabs_api_key == "ek_test"


def test_deepgram_only_succeeds_with_deepgram_key(tmp_path):
    """Both providers set to deepgram succeed with only DEEPGRAM_API_KEY."""
    _write_env(tmp_path, {
        "DEEPGRAM_API_KEY": "dg_test",
        "STT_PROVIDER": "deepgram",
        "TTS_PROVIDER": "deepgram",
    })
    config = load_config()
    assert config.stt_provider == "deepgram"
    assert config.tts_provider == "deepgram"
    assert config.deepgram_api_key == "dg_test"


def test_mixed_providers_requires_both_keys(tmp_path):
    """STT=elevenlabs + TTS=deepgram requires both API keys."""
    _write_env(tmp_path, {
        "ELEVENLABS_API_KEY": "ek_test",
        "DEEPGRAM_API_KEY": "dg_test",
        "STT_PROVIDER": "elevenlabs",
        "TTS_PROVIDER": "deepgram",
    })
    config = load_config()
    assert config.stt_provider == "elevenlabs"
    assert config.tts_provider == "deepgram"


# ============================================================================
# TESTS: MISSING API KEYS
# ============================================================================

def test_missing_elevenlabs_key_raises_when_active(tmp_path):
    """Raises ValueError when ElevenLabs is active but key is missing."""
    _write_env(tmp_path, {"STT_PROVIDER": "elevenlabs", "TTS_PROVIDER": "elevenlabs"})
    with pytest.raises(ValueError, match="ELEVENLABS_API_KEY"):
        load_config()


def test_missing_deepgram_key_raises_when_active(tmp_path):
    """Raises ValueError when Deepgram is active but key is missing."""
    _write_env(tmp_path, {
        "ELEVENLABS_API_KEY": "ek_test",
        "STT_PROVIDER": "elevenlabs",
        "TTS_PROVIDER": "deepgram",
    })
    with pytest.raises(ValueError, match="DEEPGRAM_API_KEY"):
        load_config()


def test_missing_elevenlabs_key_ok_when_deepgram_only(tmp_path):
    """No error when ElevenLabs key missing but both providers are Deepgram."""
    _write_env(tmp_path, {
        "DEEPGRAM_API_KEY": "dg_test",
        "STT_PROVIDER": "deepgram",
        "TTS_PROVIDER": "deepgram",
    })
    config = load_config()
    assert config.elevenlabs_api_key == ""


# ============================================================================
# TESTS: INVALID PROVIDER STRINGS
# ============================================================================

def test_invalid_stt_provider_raises(tmp_path):
    """Raises ValueError on unrecognized STT_PROVIDER value."""
    _write_env(tmp_path, {
        "ELEVENLABS_API_KEY": "ek_test",
        "STT_PROVIDER": "whisper",
    })
    with pytest.raises(ValueError, match="Invalid STT_PROVIDER"):
        load_config()


def test_invalid_tts_provider_raises(tmp_path):
    """Raises ValueError on unrecognized TTS_PROVIDER value."""
    _write_env(tmp_path, {
        "ELEVENLABS_API_KEY": "ek_test",
        "TTS_PROVIDER": "google",
    })
    with pytest.raises(ValueError, match="Invalid TTS_PROVIDER"):
        load_config()
