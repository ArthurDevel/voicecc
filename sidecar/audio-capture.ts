/**
 * Microphone audio capture via sox.
 *
 * Spawns sox directly to capture raw 16-bit signed PCM from the default mic.
 * Avoids node-record-lpcm16's `encoding: 'binary'` bug that zeros out audio data.
 *
 * Responsibilities:
 * - Start/stop sox-based mic recording at a given sample rate
 * - Provide a readable stream of raw 16-bit signed PCM data
 * - Convert raw PCM buffers to Float32Array for downstream VAD/STT consumption
 */

import { spawn, type ChildProcess } from "child_process";
import { Readable } from "stream";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Divisor for normalizing 16-bit signed PCM to -1.0..1.0 range */
const PCM_16BIT_MAX = 32768.0;

/** Number of bytes per 16-bit sample */
const BYTES_PER_SAMPLE = 2;

// ============================================================================
// STATE
// ============================================================================

/** The active sox child process */
let soxProcess: ChildProcess | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Starts sox-based microphone recording and returns a readable stream of raw PCM data.
 *
 * @param sampleRate - Audio sample rate in Hz (e.g. 16000)
 * @returns Readable stream emitting raw 16-bit signed PCM buffers
 * @throws Error if already capturing
 */
function startCapture(sampleRate: number): Readable {
  if (soxProcess) {
    throw new Error("Capture already in progress. Call stopCapture() first.");
  }

  soxProcess = spawn("sox", [
    "--default-device",
    "--no-show-progress",
    "--rate", String(sampleRate),
    "--channels", "1",
    "--encoding", "signed-integer",
    "--bits", "16",
    "--type", "raw",
    "-",
  ]);

  if (!soxProcess.stdout) {
    throw new Error("Failed to capture sox stdout");
  }

  soxProcess.on("error", (err) => {
    throw new Error(`sox failed to start (is sox installed?): ${err.message}`);
  });

  return soxProcess.stdout;
}

/**
 * Stops the active mic recording by killing the sox child process.
 */
function stopCapture(): void {
  if (!soxProcess) {
    return;
  }

  soxProcess.kill();
  soxProcess = null;
}

/**
 * Returns whether the microphone is currently capturing audio.
 *
 * @returns true if a recording is active
 */
function isCapturing(): boolean {
  return soxProcess !== null;
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

export { startCapture, stopCapture, isCapturing, bufferToFloat32 };
