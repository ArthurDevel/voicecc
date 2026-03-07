# Voice CC

A Claude Code plugin for hands-free voice interaction with ElevenLabs speech-to-text, text-to-speech, and voice activity detection.

## Project Structure

```
server/             Backend: voice pipeline + orchestration services
  voice/            Real-time audio: STT, TTS, VAD, session management
  services/         Orchestration: tunnel, Twilio, browser calls, agents
  index.ts          Entry point (boots dashboard + auto-starts integrations)
dashboard/          Web UI (Vite + React) + API routes (Hono)
lander/             Static landing page
init/               Default prompt templates for new agents
scripts/            Setup utilities (postinstall)
bin/                CLI entry point (voicecc command)
```

## Installation

### Prerequisites

- macOS or Linux
- Node.js 18+
- An ElevenLabs API key

### Install

```bash
# 1. Install system dependencies (macOS)
xcode-select --install
brew install cloudflared

# 2. Install Voice CC
npm install -g voicecc

# 3. Start the dashboard
voicecc
```

## How It Works

1. **Mic capture**: VPIO (macOS) or PulseAudio (Linux) records 16kHz mono PCM with echo cancellation
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: ElevenLabs Scribe API transcribes audio
4. **Endpointing**: VAD silence-based turn detection
5. **Claude inference**: Transcript sent to Claude Code Agent SDK session with streaming response
6. **Narration**: Claude's response stripped of markdown and split into sentences
7. **Text-to-speech**: ElevenLabs streaming TTS API generates audio
8. **Speaker playback**: Audio output through VPIO/PulseAudio at 24kHz
