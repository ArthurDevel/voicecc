# Claude Code Voice Plugin

A Claude Code plugin that adds a `/voice` command for hands-free voice interaction with local speech-to-text, text-to-speech, and voice activity detection.

## Prerequisites

- Node.js 18+
- sox (`brew install sox` on macOS, `apt-get install sox` on Linux)
- An Anthropic API key (already present if using Claude Code)
- Headphones recommended (no echo cancellation in v1)

## Setup

```bash
# 1. Install sox (required for mic capture)
brew install sox          # macOS
# apt-get install sox     # Linux

# 2. Create model cache directory
mkdir -p ~/.claude-voice-models

# 3. Install Node dependencies
cd claude-code-voice
npm install
```

## Whisper Model Download

The plugin uses a local Whisper ONNX model for speech-to-text. Run these commands to download and set it up:

```bash
# Download the model archive (~606MB)
cd ~/.claude-voice-models
wget https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2

# Extract it
tar xvf sherpa-onnx-whisper-small.en.tar.bz2

# Rename to match the expected directory name
mv sherpa-onnx-whisper-small.en whisper-small

# Clean up the archive
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
- **Interrupt Claude**: Start speaking while Claude is narrating (requires 300ms of sustained speech to avoid false triggers)

## How It Works

The voice loop runs locally with zero external API calls except to Claude and optional semantic endpointing:

1. **Mic capture**: sox records 16kHz mono PCM audio
2. **Voice activity detection**: Silero VAD v5 detects speech segments
3. **Speech-to-text**: sherpa-onnx (Whisper ONNX model) transcribes audio locally
4. **Endpointing**: Two-tier turn detection — fast VAD silence-based path, with Haiku semantic fallback for ambiguous single-word utterances
5. **Claude inference**: Transcript sent to Claude Code Agent SDK V1 session with streaming response
6. **Narration**: Claude's response processed at sentence granularity for speech
7. **Text-to-speech**: kokoro-js generates speech locally at 24kHz
8. **Speaker playback**: Audio output through system speakers

Target latency: under 2 seconds from end-of-speech to first audio playback (excluding Claude inference time).

## Troubleshooting

- **"sox not found"**: Install sox with `brew install sox` (macOS) or `apt-get install sox` (Linux)
- **"Whisper model not found"**: Download the model as described in the Whisper Model Download section
- **Mic permission denied**: Grant microphone permissions to your terminal or IDE
- **Unexpected stops**: Verify your system has stable CPU/memory during inference. Long responses will continue until completion
