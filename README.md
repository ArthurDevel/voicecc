# Voice CC

A Voice Agent Platform running on Claude Code. Create, manage, and deploy conversational voice agents powered by Claude, with real-time speech-to-text, text-to-speech, and voice activity detection via ElevenLabs.

## Project Structure

```
server/             Backend: voice pipeline + orchestration services
  voice/            Real-time audio: STT, TTS, VAD, session management
  services/         Orchestration: tunnel, Twilio, browser calls, agents
  index.ts          Entry point (boots dashboard + auto-starts integrations)
dashboard/          Web UI (Vite + React) + API routes (Hono)
lander/             Static landing page
init/               Default prompt templates for new agents
bin/                CLI entry point (voicecc command)
```

## Installation

### Prerequisites

- macOS or Linux
- Node.js 18+
- An ElevenLabs API key

### Install

Sets up Cloudflared Quicktunnel (optional), protects installation with password (optional), and sets up your Elevenlabs API key.

```bash
# 1. Install Voice CC
npm install -g voicecc

# 2. Start the platform
voicecc
```

## Development

```bash
# 1. Install dependencies
npm install

# 2. Start the backend server
npm start

# 3. In a separate terminal, start the dashboard with hot reload
npm run dev:dashboard
```

## How It Works

1. **Mic capture**: Browser captures 16kHz mono PCM via WebRTC
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: ElevenLabs Scribe API transcribes audio
4. **Endpointing**: VAD silence-based turn detection
5. **Claude inference**: Transcript sent to Claude Agent SDK session with streaming response
6. **Narration**: Claude's response stripped of markdown and split into sentences
7. **Text-to-speech**: ElevenLabs streaming TTS API generates audio
8. **Speaker playback**: Audio output through browser at 24kHz
