"""
Configuration, environment loading, prompt builder, and agent loader for the voice server.

Ports the TypeScript env.ts + prompt-builder.ts + agent-store.ts patterns to Python.

Responsibilities:
- Load environment variables from ~/.voicecc/.env
- Build system prompts with mode overlays and agent files
- Load agent config from ~/.claude-voice-agents/<agentId>/
- Provide typed VoiceServerConfig dataclass
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_VOICECC_DIR = os.path.join(os.path.expanduser("~"), ".voicecc")
DEFAULT_AGENTS_DIR = os.path.join(os.path.expanduser("~"), ".claude-voice-agents")
DEFAULT_AGENT_VOICE_ID = "IKne3meq5aSn9XLyUdCD"  # Charlie
DEFAULT_NON_AGENT_VOICE_ID = "WrjxnKxK0m1uiaH0uteU"
DEFAULT_TTS_MODEL = "eleven_turbo_v2_5"
DEFAULT_STT_MODEL = "scribe_v1"
DEFAULT_WEBRTC_PORT = 7860
DEFAULT_API_PORT = 7861
DEFAULT_TWILIO_PORT = 8080
DEFAULT_MAX_CONCURRENT_SESSIONS = 2

# Project root is the parent of voice-server/
PROJECT_ROOT = str(Path(__file__).resolve().parent.parent)
DEFAULTS_DIR = os.path.join(PROJECT_ROOT, "init", "defaults")


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class VoicePreference:
    """Voice preference for a TTS provider."""
    id: str
    name: str


@dataclass
class AgentVoiceConfig:
    """Per-provider voice preferences."""
    elevenlabs: VoicePreference | None = None
    local: VoicePreference | None = None


@dataclass
class AgentConfig:
    """Configuration stored in config.json for each agent."""
    heartbeat_interval_minutes: int = 10
    heartbeat_timeout_minutes: int | None = None
    enabled: bool = True
    voice: AgentVoiceConfig | None = None


@dataclass
class Agent:
    """Full agent data including all file contents."""
    id: str
    soul_md: str
    memory_md: str
    heartbeat_md: str
    config: AgentConfig


@dataclass
class VoiceServerConfig:
    """Typed configuration for the voice server."""
    webrtc_port: int
    api_port: int
    tunnel_url: str | None
    elevenlabs_api_key: str
    elevenlabs_voice_id: str
    elevenlabs_tts_model: str
    elevenlabs_stt_model: str
    agents_dir: str
    default_cwd: str
    project_root: str
    twilio_account_sid: str
    twilio_auth_token: str
    user_phone_number: str
    max_concurrent_sessions: int


# ============================================================================
# MAIN HANDLERS
# ============================================================================

def load_config() -> VoiceServerConfig:
    """Load environment variables from ~/.voicecc/.env and return a typed config.

    Reads .env using python-dotenv, then extracts all required values.
    Fails fast if ELEVENLABS_API_KEY is missing.

    Returns:
        VoiceServerConfig with all settings populated
    """
    voicecc_dir = os.environ.get("VOICECC_DIR", DEFAULT_VOICECC_DIR)
    env_path = os.path.join(voicecc_dir, ".env")
    load_dotenv(env_path)

    api_key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not api_key:
        raise ValueError("ELEVENLABS_API_KEY is required in ~/.voicecc/.env")

    return VoiceServerConfig(
        webrtc_port=int(os.environ.get("WEBRTC_PORT", str(DEFAULT_WEBRTC_PORT))),
        api_port=int(os.environ.get("API_PORT", str(DEFAULT_API_PORT))),
        tunnel_url=os.environ.get("TUNNEL_URL"),
        elevenlabs_api_key=api_key,
        elevenlabs_voice_id=os.environ.get("ELEVENLABS_VOICE_ID", DEFAULT_NON_AGENT_VOICE_ID),
        elevenlabs_tts_model=os.environ.get("ELEVENLABS_MODEL_ID", DEFAULT_TTS_MODEL),
        elevenlabs_stt_model=os.environ.get("ELEVENLABS_STT_MODEL_ID", DEFAULT_STT_MODEL),
        agents_dir=os.environ.get("AGENTS_DIR", DEFAULT_AGENTS_DIR),
        default_cwd=os.environ.get("DEFAULT_CWD", os.path.expanduser("~")),
        project_root=PROJECT_ROOT,
        twilio_account_sid=os.environ.get("TWILIO_ACCOUNT_SID", ""),
        twilio_auth_token=os.environ.get("TWILIO_AUTH_TOKEN", ""),
        user_phone_number=os.environ.get("USER_PHONE_NUMBER", ""),
        max_concurrent_sessions=int(
            os.environ.get("MAX_CONCURRENT_SESSIONS") or DEFAULT_MAX_CONCURRENT_SESSIONS
        ),
    )


def build_system_prompt(agent_id: str | None, overlay: str) -> str:
    """Build a complete system prompt with mode overlay and optional agent files.

    Reads the base system.md template, replaces <<MODE_OVERLAY>> with the
    given overlay, and if agent_id is provided, injects SOUL/MEMORY/HEARTBEAT
    files and the agent directory path.

    Args:
        agent_id: Agent identifier, or None for default prompt
        overlay: "voice" or "text" -- selects the overlay file

    Returns:
        Complete system prompt string
    """
    base_template = _read_template("system.md")
    overlay_content = _read_overlay(overlay)

    prompt = base_template.replace("<<MODE_OVERLAY>>", overlay_content)

    if agent_id:
        agent = load_agent(agent_id)
        agent_dir = os.path.join(DEFAULT_AGENTS_DIR, agent_id)

        agent_files = "\n\n".join([
            f"<SOUL.md>\n{agent.soul_md}\n</SOUL.md>",
            f"<HEARTBEAT.md>\n{agent.heartbeat_md}\n</HEARTBEAT.md>",
            f"<MEMORY.md>\n{agent.memory_md}\n</MEMORY.md>",
        ])

        prompt = prompt.replace("<<AGENT_DIR>>", agent_dir)
        prompt = prompt.replace("<<AGENT_FILES>>", agent_files)

    return prompt


def load_agent(agent_id: str) -> Agent:
    """Read agent data from ~/.claude-voice-agents/<agentId>/.

    Reads SOUL.md, MEMORY.md, HEARTBEAT.md, and config.json.
    Fails fast if the agent directory does not exist.

    Args:
        agent_id: Agent identifier

    Returns:
        Agent with all file contents loaded
    """
    agent_dir = os.path.join(DEFAULT_AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise FileNotFoundError(f'Agent "{agent_id}" not found at {agent_dir}')

    soul_md = _read_file(os.path.join(agent_dir, "SOUL.md"))
    memory_md = _read_file(os.path.join(agent_dir, "MEMORY.md"))
    heartbeat_md = _read_file(os.path.join(agent_dir, "HEARTBEAT.md"))
    config = _read_agent_config(os.path.join(agent_dir, "config.json"))

    return Agent(
        id=agent_id,
        soul_md=soul_md,
        memory_md=memory_md,
        heartbeat_md=heartbeat_md,
        config=config,
    )


def list_agents(agents_dir: str | None = None) -> list[Agent]:
    """List all agents that have heartbeat enabled.

    Scans the agents directory for subdirectories with config.json,
    returns only those with enabled=True.

    Args:
        agents_dir: Override agents directory path (defaults to DEFAULT_AGENTS_DIR)

    Returns:
        List of Agent objects with enabled=True
    """
    dir_path = agents_dir or DEFAULT_AGENTS_DIR
    if not os.path.isdir(dir_path):
        return []

    agents: list[Agent] = []
    for entry in os.listdir(dir_path):
        entry_path = os.path.join(dir_path, entry)
        if not os.path.isdir(entry_path):
            continue
        config_path = os.path.join(entry_path, "config.json")
        if not os.path.isfile(config_path):
            continue

        try:
            agent = load_agent(entry)
            if agent.config.enabled:
                agents.append(agent)
        except Exception as e:
            print(f"[config] Skipping agent {entry}: {e}")

    return agents


def get_agent_voice_id(agent_id: str | None) -> str:
    """Get the ElevenLabs voice ID for an agent, falling back to defaults.

    Args:
        agent_id: Agent identifier, or None

    Returns:
        ElevenLabs voice ID string
    """
    if not agent_id:
        return DEFAULT_NON_AGENT_VOICE_ID

    try:
        agent = load_agent(agent_id)
        if agent.config.voice and agent.config.voice.elevenlabs:
            return agent.config.voice.elevenlabs.id
    except FileNotFoundError:
        pass

    return DEFAULT_AGENT_VOICE_ID


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _read_file(path: str) -> str:
    """Read a file and return its contents as a string.

    Args:
        path: Absolute path to the file

    Returns:
        File contents, or empty string if file does not exist
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def _read_template(filename: str) -> str:
    """Read a template file from init/defaults/.

    Args:
        filename: Name of the template file

    Returns:
        Template contents
    """
    path = os.path.join(DEFAULTS_DIR, filename)
    content = _read_file(path)
    if not content:
        raise FileNotFoundError(f"Template not found: {path}")
    return content


def _read_overlay(overlay: str) -> str:
    """Read a mode overlay file (voice or text).

    Args:
        overlay: "voice" or "text"

    Returns:
        Overlay file contents
    """
    filename_map = {
        "voice": "system-voice-overlay.md",
        "text": "system-text-overlay.md",
    }
    filename = filename_map.get(overlay)
    if not filename:
        raise ValueError(f'Unknown overlay mode: "{overlay}". Expected "voice" or "text".')
    return _read_template(filename)


def _read_agent_config(config_path: str) -> AgentConfig:
    """Parse an agent's config.json into an AgentConfig dataclass.

    Args:
        config_path: Path to config.json

    Returns:
        Parsed AgentConfig
    """
    with open(config_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    voice_config = None
    if "voice" in raw:
        voice_raw = raw["voice"]
        elevenlabs = None
        if "elevenlabs" in voice_raw:
            el = voice_raw["elevenlabs"]
            elevenlabs = VoicePreference(id=el["id"], name=el["name"])
        voice_config = AgentVoiceConfig(elevenlabs=elevenlabs)

    return AgentConfig(
        heartbeat_interval_minutes=raw.get("heartbeatIntervalMinutes", 10),
        heartbeat_timeout_minutes=raw.get("heartbeatTimeoutMinutes"),
        enabled=raw.get("enabled", True),
        voice=voice_config,
    )
