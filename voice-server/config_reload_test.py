"""Test that load_config() always reads fresh values from the .env file.

Catches regressions where env vars get cached at startup instead of being
re-read on each call.  If a new setting is added to VoiceServerConfig and
backed by an env var, add it to ENV_BACKED_FIELDS below so it's covered.

Run: cd voice-server && python -m pytest config_reload_test.py -v
"""

import os
import tempfile
from pathlib import Path

import pytest

from config import load_config, VoiceServerConfig


# Map of VoiceServerConfig field -> (env var name, first value, second value)
# Add new env-backed settings here to keep them covered.
ENV_BACKED_FIELDS: dict[str, tuple[str, str, str]] = {
    "twilio_account_sid":   ("TWILIO_ACCOUNT_SID",      "AC_old_sid",       "AC_new_sid"),
    "twilio_auth_token":    ("TWILIO_AUTH_TOKEN",        "old_token",        "new_token"),
    "twilio_phone_number":  ("TWILIO_PHONE_NUMBER",      "+10000000000",     "+19999999999"),
    "user_phone_number":    ("USER_PHONE_NUMBER",        "+11111111111",     "+12222222222"),
    "elevenlabs_api_key":   ("ELEVENLABS_API_KEY",       "ek_old_key",       "ek_new_key"),
    "elevenlabs_voice_id":  ("ELEVENLABS_VOICE_ID",      "voice_old",        "voice_new"),
    "elevenlabs_tts_model": ("ELEVENLABS_MODEL_ID",      "model_old",        "model_new"),
    "elevenlabs_stt_model": ("ELEVENLABS_STT_MODEL_ID",  "stt_old",          "stt_new"),
    "deepgram_api_key":     ("DEEPGRAM_API_KEY",         "dg_old_key",       "dg_new_key"),
    "deepgram_stt_model":   ("DEEPGRAM_STT_MODEL",       "nova-2",           "nova-3"),
    "deepgram_tts_voice":   ("DEEPGRAM_TTS_VOICE",       "aura-asteria-en",  "aura-luna-en"),
}

# Env vars we write into every .env so load_config() doesn't fail validation
REQUIRED_DEFAULTS = {
    "ELEVENLABS_API_KEY": "ek_placeholder",
}


def _write_env(path: Path, overrides: dict[str, str]) -> None:
    """Write a .env file with required defaults + overrides."""
    merged = {**REQUIRED_DEFAULTS, **overrides}
    path.write_text("\n".join(f"{k}={v}" for k, v in merged.items()) + "\n")


@pytest.fixture(autouse=True)
def _isolated_env(tmp_path, monkeypatch):
    """Point VOICECC_DIR at a temp dir and clean up env vars after each test."""
    monkeypatch.setenv("VOICECC_DIR", str(tmp_path))

    # Clear all env vars we test so there's no bleed between tests
    for _, (env_var, _, _) in ENV_BACKED_FIELDS.items():
        monkeypatch.delenv(env_var, raising=False)
    for k in REQUIRED_DEFAULTS:
        monkeypatch.delenv(k, raising=False)


def test_load_config_picks_up_changed_values(tmp_path):
    """load_config() must return updated values after the .env file changes."""
    env_file = tmp_path / ".env"

    # Write initial values
    initial = {env_var: v1 for env_var, v1, _ in ENV_BACKED_FIELDS.values()}
    _write_env(env_file, initial)

    config1 = load_config()
    for field_name, (_, v1, _) in ENV_BACKED_FIELDS.items():
        assert getattr(config1, field_name) == v1, (
            f"{field_name} was not {v1!r} on first read"
        )

    # Overwrite with new values
    updated = {env_var: v2 for env_var, _, v2 in ENV_BACKED_FIELDS.values()}
    _write_env(env_file, updated)

    config2 = load_config()
    for field_name, (_, _, v2) in ENV_BACKED_FIELDS.items():
        assert getattr(config2, field_name) == v2, (
            f"{field_name} was not updated to {v2!r} on second read — "
            "load_config() is returning stale values"
        )


def test_new_env_var_appears_after_file_update(tmp_path):
    """If TWILIO_PHONE_NUMBER is absent initially and added later, it's picked up."""
    env_file = tmp_path / ".env"

    # Start without TWILIO_PHONE_NUMBER
    _write_env(env_file, {})
    config1 = load_config()
    assert config1.twilio_phone_number == ""

    # Add it
    _write_env(env_file, {"TWILIO_PHONE_NUMBER": "+15550001234"})
    config2 = load_config()
    assert config2.twilio_phone_number == "+15550001234", (
        "TWILIO_PHONE_NUMBER not picked up after being added to .env"
    )
