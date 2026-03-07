/**
 * Entry point for the Claude Code voice server.
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

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createLocalAudioAdapter } from "./local-audio.js";
import { createVoiceSession } from "./voice-session.js";

import type { TtsProviderConfig, SttProviderConfig } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT = readFileSync(join(__dirname, "..", "..", "init", "defaults", "system.md"), "utf-8").trim();

/** Mic capture sample rate in Hz (must match VAD/STT expectations) */
const MIC_SAMPLE_RATE = 16000;

/** TTS output sample rate in Hz */
const TTS_SAMPLE_RATE = 24000;

/** Read ElevenLabs config from environment */
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "WrjxnKxK0m1uiaH0uteU";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5";
const ELEVENLABS_STT_MODEL_ID = process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1";

/** TTS provider configuration built from env vars */
const ttsProvider: TtsProviderConfig = {
  provider: "elevenlabs",
  elevenlabs: { apiKey: ELEVENLABS_API_KEY, voiceId: ELEVENLABS_VOICE_ID, modelId: ELEVENLABS_MODEL_ID },
};

/** STT provider configuration built from env vars */
const sttProvider: SttProviderConfig = {
  provider: "elevenlabs",
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
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
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
