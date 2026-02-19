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

// ============================================================================
// CONSTANTS
// ============================================================================

/** Mic capture sample rate in Hz (must match VAD/STT expectations) */
const MIC_SAMPLE_RATE = 16000;

/** TTS output sample rate in Hz -- must match tts-server.py output format */
const TTS_SAMPLE_RATE = 24000;

/** Default configuration for the voice session */
const DEFAULT_CONFIG = {
  stopPhrase: "stop listening",
  sttModelPath: join(homedir(), ".claude-voice-models", "whisper-small"),
  ttsModel: "prince-canuma/Kokoro-82M",
  ttsVoice: "af_heart",
  modelCacheDir: join(homedir(), ".claude-voice-models"),
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
