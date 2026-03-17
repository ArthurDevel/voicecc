# VoiceCC

[![npm version](https://img.shields.io/npm/v/voicecc.svg)](https://www.npmjs.com/package/voicecc)
[![npm downloads](https://img.shields.io/npm/dm/voicecc.svg)](https://www.npmjs.com/package/voicecc)
[![license](https://img.shields.io/npm/l/voicecc.svg)](https://github.com/ArthurDevel/voicecc/blob/main/LICENSE)

A Voice Agent Platform running on Claude Code. Create, manage, and deploy conversational voice agents powered by Claude, with real-time speech-to-text, text-to-speech, and voice activity detection via ElevenLabs.

## Project Structure

```
voice-server/       Python FastAPI: real-time audio pipeline (VAD, STT, TTS, Claude sessions)
server/             Node.js orchestration: boots dashboard + voice server, manages integrations
  services/         Tunnel, Twilio, browser calls, agents, device pairing
  index.ts          Entry point (spawns voice-server + dashboard, auto-starts integrations)
dashboard/          Web UI (Vite + React) + API routes (Hono)
lander/             Static landing page
init/               Default prompt templates for new agents
bin/                CLI entry point (voicecc command)
```

## Install

### Prerequisites

- macOS or Linux
- Node.js 18+
- Python 3.11+ with `venv`
- An ElevenLabs API key

### Terminal

Sets up Cloudflared Quicktunnel (optional), protects installation with password (optional), and sets up your Elevenlabs API key.

```bash
# 1. Install Voice CC
npm install -g voicecc

# 2. Start the platform
voicecc
```

## How It Works

The platform runs two servers: a **Node.js orchestrator** (dashboard, integrations, CLI) and a **Python voice server** (real-time audio pipeline via Pipecat).

1. **Mic capture**: Browser captures audio via WebRTC, connected to the Python voice server
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: ElevenLabs Scribe transcribes audio
4. **Endpointing**: VAD silence-based turn detection
5. **Claude inference**: Transcript sent to Claude Agent SDK session with streaming response
6. **Narration**: Claude's response stripped of markdown and split into sentences
7. **Text-to-speech**: ElevenLabs streaming TTS generates audio
8. **Speaker playback**: Audio streamed back through WebRTC
