/**
 * Entry point for the Claude Code voice sidecar.
 *
 * Thin wrapper that creates a local audio adapter and voice session.
 * All voice loop logic lives in voice-session.ts.
 *
 * Responsibilities:
 * - Load .env configuration via dotenv
 * - Create a local AudioAdapter (VPIO echo cancellation)
 * - Create a voice session with default config
 * - Handle SIGINT/SIGTERM for clean shutdown
 */

import "dotenv/config";

import { homedir } from "os";
import { join } from "path";

import { createLocalAudioAdapter } from "./local-audio.js";
import { createVoiceSession } from "./voice-session.js";

import type { TtsProviderConfig, SttProviderConfig, TtsProviderType, SttProviderType } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Mic capture sample rate in Hz (must match VAD/STT expectations) */
const MIC_SAMPLE_RATE = 16000;

/** TTS output sample rate in Hz -- must match tts-server.py output format */
const TTS_SAMPLE_RATE = 24000;

/** Read provider selection and ElevenLabs config from environment */
const TTS_PROVIDER = (process.env.TTS_PROVIDER ?? "local") as TtsProviderType;
const STT_PROVIDER = (process.env.STT_PROVIDER ?? "local") as SttProviderType;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5";
const ELEVENLABS_STT_MODEL_ID = process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1";

/** TTS provider configuration built from env vars */
const ttsProvider: TtsProviderConfig = {
  provider: TTS_PROVIDER,
  local: { model: "prince-canuma/Kokoro-82M", voice: "af_heart" },
  elevenlabs: { apiKey: ELEVENLABS_API_KEY, voiceId: ELEVENLABS_VOICE_ID, modelId: ELEVENLABS_MODEL_ID },
};

/** STT provider configuration built from env vars */
const sttProvider: SttProviderConfig = {
  provider: STT_PROVIDER,
  local: { modelPath: join(homedir(), ".claude-voice-models", "whisper-small") },
  elevenlabs: { apiKey: ELEVENLABS_API_KEY, modelId: ELEVENLABS_STT_MODEL_ID },
};

/** Default configuration for the voice session */
const DEFAULT_CONFIG = {
  stopPhrase: "stop listening",
  ttsProvider,
  sttProvider,
  interruptionThresholdMs: 1500,
  endpointing: {
    silenceThresholdMs: 700,
    maxSilenceBeforeTimeoutMs: 1200,
    minWordCountForFastPath: 2,
    enableHaikuFallback: false,
  },
  narration: {
    summaryIntervalMs: 12000,
  },
  claudeSession: {
    allowedTools: [] as string[],
    permissionMode: "bypassPermissions",
    systemPrompt:
      "Respond concisely. You are in voice mode -- your responses will be spoken aloud. Keep answers conversational and brief.",
  },
};

// ============================================================================
// ENTRY POINT
// ============================================================================

/**
 * Main entry point. Creates the local audio adapter and voice session,
 * then waits for shutdown via stop phrase or signal.
 */
async function main(): Promise<void> {
  const adapter = await createLocalAudioAdapter(MIC_SAMPLE_RATE, TTS_SAMPLE_RATE);

  const session = await createVoiceSession(adapter, {
    ...DEFAULT_CONFIG,
    onSessionEnd: () => process.exit(0),
  });

  const signalHandler = () => {
    session.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);
}

main().catch((err) => {
  console.error(`Voice loop failed: ${err}`);
  process.exit(1);
});
