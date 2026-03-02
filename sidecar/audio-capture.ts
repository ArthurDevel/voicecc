/**
 * Platform dispatcher for audio I/O with echo cancellation.
 *
 * Detects the current platform via process.platform and delegates all audio
 * operations to the appropriate platform-specific module (darwin or linux).
 *
 * Responsibilities:
 * - Route audio I/O calls to the correct platform implementation
 * - Export the AudioIO type and bufferToFloat32 utility for downstream consumers
 * - Track which platform is active to dispatch stop/interrupt/resume correctly
 */

import type { Readable, Writable } from "stream";

import {
  startCaptureDarwin,
  stopCaptureDarwin,
  interruptPlaybackDarwin,
  resumePlaybackDarwin,
} from "./audio-capture-darwin.js";

import {
  startCaptureLinux,
  stopCaptureLinux,
  interruptPlaybackLinux,
  resumePlaybackLinux,
} from "./audio-capture-linux.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Divisor for normalizing 16-bit signed PCM to -1.0..1.0 range */
const PCM_16BIT_MAX = 32768.0;

/** Number of bytes per 16-bit sample */
const BYTES_PER_SAMPLE = 2;

// ============================================================================
// INTERFACES
// ============================================================================

/** Streams returned by startCapture for both mic input and speaker output */
interface AudioIO {
  /** Readable stream of echo-cancelled mic PCM (16-bit signed, mono) */
  micStream: Readable;
  /** Writable stream for TTS PCM playback (16-bit signed, mono) */
  speakerInput: Writable;
}

// ============================================================================
// STATE
// ============================================================================

/** Tracks which platform module is currently active */
let activePlatform: "darwin" | "linux" | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start audio I/O with echo cancellation on the current platform.
 *
 * Detects the platform via process.platform and delegates to the appropriate
 * platform-specific implementation.
 *
 * @param micRate - Mic output sample rate in Hz (e.g. 16000 for VAD/STT)
 * @param speakerRate - Speaker input sample rate in Hz (e.g. 24000 for TTS)
 * @returns AudioIO with mic and speaker streams
 * @throws Error if platform is unsupported or capture is already active
 */
async function startCapture(micRate: number, speakerRate: number): Promise<AudioIO> {
  if (activePlatform) {
    throw new Error("Capture already in progress. Call stopCapture() first.");
  }

  switch (process.platform) {
    case "darwin": {
      const io = await startCaptureDarwin(micRate, speakerRate);
      activePlatform = "darwin";
      return io;
    }
    case "linux": {
      const io = await startCaptureLinux(micRate, speakerRate);
      activePlatform = "linux";
      return io;
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

/**
 * Stop audio I/O and free resources on the active platform.
 */
function stopCapture(): void {
  if (!activePlatform) return;

  switch (activePlatform) {
    case "darwin":
      stopCaptureDarwin();
      break;
    case "linux":
      stopCaptureLinux();
      break;
  }

  activePlatform = null;
}

/**
 * Interrupt current speaker playback on the active platform.
 * Clears any buffered audio so playback stops immediately.
 */
function interruptPlayback(): void {
  switch (activePlatform) {
    case "darwin":
      interruptPlaybackDarwin();
      break;
    case "linux":
      interruptPlaybackLinux();
      break;
  }
}

/**
 * Resume speaker playback after an interrupt on the active platform.
 * Must be called before writing new audio after an interrupt.
 */
function resumePlayback(): void {
  switch (activePlatform) {
    case "darwin":
      resumePlaybackDarwin();
      break;
    case "linux":
      resumePlaybackLinux();
      break;
  }
}

/**
 * Returns whether audio I/O is currently active.
 *
 * @returns true if a platform capture session is running
 */
function isCapturing(): boolean {
  return activePlatform !== null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts a raw 16-bit signed PCM buffer to a Float32Array normalized to -1.0..1.0.
 *
 * Each pair of bytes in the buffer represents one 16-bit signed little-endian sample.
 * The normalized value is computed as: sample / 32768.0
 *
 * @param buffer - Raw 16-bit signed PCM buffer from the mic stream
 * @returns Float32Array with values in the range -1.0 to 1.0
 */
function bufferToFloat32(buffer: Buffer): Float32Array {
  const sampleCount = buffer.length / BYTES_PER_SAMPLE;
  const float32 = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const sample = buffer.readInt16LE(i * BYTES_PER_SAMPLE);
    float32[i] = sample / PCM_16BIT_MAX;
  }

  return float32;
}

export { startCapture, stopCapture, interruptPlayback, resumePlayback, isCapturing, bufferToFloat32 };
export type { AudioIO };
