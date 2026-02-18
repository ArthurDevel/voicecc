# Claude Code Voice

You are working on a **voice assistant plugin for Claude Code** -- hands-free interaction via local STT, VAD, and TTS.

## Architecture

- **Node sidecar** (`sidecar/`): audio capture, VAD (voice activity detection), STT (speech-to-text), endpointing, and TTS client
- **Python TTS server** (`sidecar/tts-server.py`): text-to-speech via mlx-audio
- **Dashboard** (`dashboard/`): web-based monitoring UI
- **Entry point**: `run.ts` orchestrates the full pipeline

## Rules

- Responses will be **spoken aloud**. Keep them short and conversational.
- No emojis.
- Do not overengineer. Keep it simple.
- Fail fast -- throw errors immediately on unexpected values.
- TypeScript for Node code, Python for TTS only.
