/**
 * macOS audio I/O via Voice Processing IO (VPIO) with echo cancellation.
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
 */

import { spawn, type ChildProcess } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { AudioIO } from "./audio-capture.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Path to the compiled mic-vpio binary */
const __dirname = dirname(fileURLToPath(import.meta.url));
const MIC_VPIO_BIN = join(__dirname, "mic-vpio");

/** Timeout for the VPIO binary to initialize (ms) */
const READY_TIMEOUT_MS = 10_000;

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
async function startCaptureDarwin(micRate: number, speakerRate: number): Promise<AudioIO> {
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
 * Stop the VPIO audio I/O process and free resources.
 */
function stopCaptureDarwin(): void {
  if (!vpioProcess) return;
  vpioProcess.kill();
  vpioProcess = null;
}

/**
 * Interrupt current speaker playback by clearing the VPIO ring buffer.
 * Sends SIGUSR1 to the mic-vpio process which clears pending audio
 * and starts discarding any stale PCM data remaining in the OS pipe buffer.
 */
function interruptPlaybackDarwin(): void {
  if (vpioProcess) {
    vpioProcess.kill("SIGUSR1");
  }
}

/**
 * Resume speaker playback after an interrupt.
 * Sends SIGUSR2 to the mic-vpio process which stops discarding stdin data,
 * allowing new PCM audio to flow through to the ring buffer and speakers.
 * Must be called before writing new audio after an interrupt.
 */
function resumePlaybackDarwin(): void {
  if (vpioProcess) {
    vpioProcess.kill("SIGUSR2");
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Wait for the mic-vpio binary to print READY on stderr.
 *
 * @param proc - The mic-vpio child process
 * @returns Resolves when the binary reports READY
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

export { startCaptureDarwin, stopCaptureDarwin, interruptPlaybackDarwin, resumePlaybackDarwin };
