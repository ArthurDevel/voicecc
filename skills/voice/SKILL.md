---
name: voice
description: Start voice mode for hands-free interaction via microphone
allowed-tools: ["Bash"]
---

# Voice Mode

Start the voice sidecar process. This launches a local voice loop that captures microphone input, transcribes speech locally, sends it to Claude Code, and speaks responses aloud using local TTS.

## Instructions

Run the following command via the Bash tool:

```bash
npx tsx "${PLUGIN_ROOT}/sidecar/index.ts"
```

Where `${PLUGIN_ROOT}` is the directory containing this plugin (the directory with `package.json`). The sidecar runs as a **foreground process** and blocks until the user says "stop listening" or presses Ctrl+C.

**Prerequisites:**
- `sox` must be installed on the system (e.g. `brew install sox` on macOS)
- A Whisper ONNX model must be downloaded to `~/.claude-voice-models/`
- Headphones are recommended (no echo cancellation in v1)

Do not run this in the background. The process must stay in the foreground so the user can interact with it.
