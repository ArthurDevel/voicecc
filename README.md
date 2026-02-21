# Voice CC

A Claude Code plugin for hands-free voice interaction with local speech-to-text, text-to-speech, and voice activity detection.

## Installation

### Prerequisites

- macOS with Apple Silicon (M1/M2/M3/M4)
- Node.js 18+
- Python 3.10+
- Homebrew

### Install

```bash
# 1. Install system dependencies
xcode-select --install
brew install espeak-ng cloudflared

# 2. Install Voice CC
npm install -g voicecc

# 3. Start the dashboard
voicecc
```

The postinstall script handles sox, the Whisper model, Python venv, and TTS dependencies automatically.

## How It Works

The voice loop runs locally with zero external API calls except to Claude:

1. **Mic capture**: VPIO (macOS Voice Processing IO) records 16kHz mono PCM with echo cancellation
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: sherpa-onnx (Whisper ONNX model) transcribes audio locally
4. **Endpointing**: VAD silence-based turn detection
5. **Claude inference**: Transcript sent to Claude Code Agent SDK session with streaming response
6. **Narration**: Claude's response stripped of markdown and split into sentences
7. **Text-to-speech**: Kokoro-82M via mlx-audio on Apple Silicon GPU (~8x realtime)
8. **Speaker playback**: Audio output through VPIO at 24kHz with echo cancellation

## Troubleshooting

- **"sox not found"**: Install sox with `brew install sox`
- **"espeak not installed"**: Install espeak-ng with `brew install espeak-ng`
- **tts-server.py not ready**: Ensure the Python venv is set up correctly
- **Mic permission denied**: Grant microphone permissions to your terminal or IDE
