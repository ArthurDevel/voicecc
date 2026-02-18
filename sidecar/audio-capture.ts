/**
 * Audio I/O via macOS Voice Processing IO (VPIO) with echo cancellation.
 *
 * Spawns a native mic-vpio binary that uses macOS's built-in acoustic echo
 * cancellation. The binary handles both mic capture and speaker playback
 * through a single VPIO AudioUnit, so the AEC has a reference signal of
 * what's being played to subtract from the mic input.
 *
 * Responsibilities:
 * - Start/stop the mic-vpio binary for echo-cancelled audio I/O
 * - Provide a readable stream of echo-cancelled 16-bit signed PCM mic data
 * - Provide a writable stream for TTS audio playback
 * - Support playback interruption (clears audio buffer via SIGUSR1)
 * - Convert raw PCM buffers to Float32Array for downstream VAD/STT consumption
 */

import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { Readable, Writable } from "stream";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Divisor for normalizing 16-bit signed PCM to -1.0..1.0 range */
const PCM_16BIT_MAX = 32768.0;

/** Number of bytes per 16-bit sample */
const BYTES_PER_SAMPLE = 2;

/** Path to the compiled mic-vpio binary */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIC_VPIO_BIN = join(__dirname, "mic-vpio");

/** Timeout for the VPIO binary to initialize (ms) */
const READY_TIMEOUT_MS = 10_000;

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

/** The active mic-vpio child process */
let vpioProcess: ChildProcess | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the VPIO audio I/O process with echo cancellation.
 *
 * Spawns the mic-vpio binary which sets up a macOS VoiceProcessingIO AudioUnit.
 * Waits for the binary to report READY before returning.
 *
 * @param micRate - Mic output sample rate in Hz (e.g. 16000 for VAD/STT)
 * @param speakerRate - Speaker input sample rate in Hz (e.g. 24000 for TTS)
 * @returns AudioIO with mic and speaker streams
 * @throws Error if already capturing, binary not found, or initialization fails
 */
async function startCapture(micRate: number, speakerRate: number): Promise<AudioIO> {
  if (vpioProcess) {
    throw new Error("Capture already in progress. Call stopCapture() first.");
  }

  vpioProcess = spawn(MIC_VPIO_BIN, [String(micRate), String(speakerRate)]);

  if (!vpioProcess.stdout || !vpioProcess.stdin) {
    throw new Error("Failed to get mic-vpio stdio streams");
  }

  // Wait for the binary to report READY on stderr
  await waitForReady(vpioProcess);

  return {
    micStream: vpioProcess.stdout,
    speakerInput: vpioProcess.stdin,
  };
}

/**
 * Interrupt current speaker playback by clearing the VPIO ring buffer.
 * Sends SIGUSR1 to the mic-vpio process which clears pending audio.
 */
function interruptPlayback(): void {
  if (vpioProcess) {
    vpioProcess.kill("SIGUSR1");
  }
}

/**
 * Stop the VPIO audio I/O process and free resources.
 */
function stopCapture(): void {
  if (!vpioProcess) return;
  vpioProcess.kill();
  vpioProcess = null;
}

/**
 * Returns whether audio I/O is currently active.
 *
 * @returns true if the VPIO process is running
 */
function isCapturing(): boolean {
  return vpioProcess !== null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Wait for the mic-vpio binary to print READY on stderr.
 *
 * @param proc - The mic-vpio child process
 * @throws Error if the process exits or times out before READY
 */
function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderrBuffer = "";

    const timeout = setTimeout(() => {
      reject(new Error(`mic-vpio did not become ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    const onData = (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;

      // Log non-READY stderr output (errors, diagnostics)
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && trimmed !== "READY") {
          console.log(`[mic-vpio] ${trimmed}`);
        }
      }

      if (stderrBuffer.includes("READY")) {
        clearTimeout(timeout);
        proc.stderr!.off("data", onData);

        // Continue logging stderr after READY
        proc.stderr!.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n")) {
            const trimmed = line.trim();
            if (trimmed) console.log(`[mic-vpio] ${trimmed}`);
          }
        });

        resolve();
      }
    };

    proc.stderr!.on("data", onData);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(
        `mic-vpio failed to start: ${err.message}. ` +
        `Compile with: swiftc -O -o sidecar/mic-vpio sidecar/mic-vpio.swift -framework AudioToolbox -framework CoreAudio`
      ));
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`mic-vpio exited with code ${code} before READY`));
    });
  });
}

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

export { startCapture, stopCapture, interruptPlayback, isCapturing, bufferToFloat32 };
export type { AudioIO };
