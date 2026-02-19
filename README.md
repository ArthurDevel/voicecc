# Claude Code Voice Plugin

A Claude Code plugin that adds a `/voice` command for hands-free voice interaction with local speech-to-text, text-to-speech, and voice activity detection.

## Installation

### Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- Xcode Command Line Tools (`xcode-select --install`)
- sox and espeak-ng (`brew install sox espeak-ng`)
- An Anthropic API key (already present if using Claude Code)

### Install from registry

```bash
npm install voicecc --registry http://gitea-rksscoo0o4c8o44k0s84c8s4.65.109.15.3.sslip.io/api/packages/ArthurDevel/npm/
```

The postinstall script will compile the VPIO binary, set up a Python venv, and install TTS dependencies automatically.

### Update to latest version

```bash
npm update voicecc --registry http://gitea-rksscoo0o4c8o44k0s84c8s4.65.109.15.3.sslip.io/api/packages/ArthurDevel/npm/
```

### Install from source

```bash
# 1. Install system dependencies
brew install sox espeak-ng

# 2. Install Node + Python dependencies (postinstall handles the Python venv)
npm install
```

## Whisper Model Download

The plugin uses a local Whisper ONNX model for speech-to-text. Run these commands to download and set it up:

```bash
# Download the model archive (~606MB)
mkdir -p ~/.claude-voice-models && cd ~/.claude-voice-models
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2

# Extract, rename, clean up
tar xvf sherpa-onnx-whisper-small.en.tar.bz2
mv sherpa-onnx-whisper-small.en whisper-small
rm sherpa-onnx-whisper-small.en.tar.bz2
```

After this you should have these files in `~/.claude-voice-models/whisper-small/`:
- `small.en-encoder.int8.onnx`
- `small.en-decoder.int8.onnx`
- `small.en-tokens.txt`

## Usage

### As a Claude Code Plugin

```bash
claude --plugin-dir ./claude-code-voice
```

Then type `/voice` to start voice mode.

### Standalone

```bash
npm start
```

## Voice Commands

- **Exit voice mode**: Say "stop listening" or press Ctrl+C
- **Interrupt Claude**: Start speaking while Claude is narrating (requires 800ms of sustained speech to avoid false triggers)

## How It Works

The voice loop runs locally with zero external API calls except to Claude:

1. **Mic capture**: sox records 16kHz mono PCM audio
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: sherpa-onnx (Whisper ONNX model) transcribes audio locally
4. **Endpointing**: VAD silence-based turn detection (fast path for 2+ word utterances)
5. **Claude inference**: Transcript sent to Claude Code Agent SDK session with streaming response
6. **Narration**: Claude's response stripped of markdown and split into sentences
7. **Text-to-speech**: Kokoro-82M via mlx-audio on Apple Silicon GPU (~8x realtime)
8. **Speaker playback**: Audio output through system speakers at 24kHz

### TTS subprocess architecture

TTS runs in a persistent Python child process (`sidecar/tts-server.py`) spawned once at startup. The Kokoro model is loaded onto the Apple Silicon GPU via mlx-audio and stays in memory for the entire session. Node.js communicates with it over stdio pipes — JSON commands on stdin, length-prefixed binary PCM audio on stdout. There is no HTTP server or network involved.

See [`.docs/voice-pipeline-sequence.md`](.docs/voice-pipeline-sequence.md) for a full sequence diagram.

## Troubleshooting

- **"sox not found"**: Install sox with `brew install sox`
- **"espeak not installed"**: Install espeak-ng with `brew install espeak-ng`
- **"Whisper model not found"**: Download the model as described in the Whisper Model Download section
- **tts-server.py not ready**: Ensure the Python venv is set up correctly (`sidecar/.venv/bin/python3 -c "from mlx_audio.tts.utils import load_model; print('ok')"`)
- **Mic permission denied**: Grant microphone permissions to your terminal or IDE
