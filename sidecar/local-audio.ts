/**
 * Local audio adapter wrapping the platform-aware audio-capture module.
 *
 * Implements the AudioAdapter interface for the local mic path. Delegates all
 * low-level audio I/O to audio-capture.ts, which dispatches to the correct
 * platform implementation (macOS VPIO or Linux parec/pacat).
 *
 * Responsibilities:
 * - Start audio capture via startCapture() (platform-dispatched)
 * - Wire mic output through bufferToFloat32 to the onAudio callback
 * - Write PCM audio to the speaker stream with backpressure handling
 * - Interrupt/resume playback
 * - Play a platform-appropriate ready chime (afplay on macOS, paplay on Linux)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { startCapture, stopCapture, interruptPlayback, resumePlayback, bufferToFloat32 } from "./audio-capture.js";

import type { Writable } from "stream";
import type { AudioAdapter } from "./audio-adapter.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** macOS system sound played when the agent finishes speaking and starts listening */
const MACOS_CHIME_PATH = "/System/Library/Sounds/Glass.aiff";

/** Linux chime WAV bundled with the package */
const __dirname = dirname(fileURLToPath(import.meta.url));
const LINUX_CHIME_PATH = join(__dirname, "assets", "chime.wav");

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create a local AudioAdapter backed by the VPIO echo-cancelling audio process.
 *
 * Starts the mic-vpio binary, wires stdout through bufferToFloat32 to the
 * onAudio callback, and returns an AudioAdapter.
 *
 * @param micRate - Mic output sample rate in Hz (e.g. 16000 for VAD/STT)
 * @param speakerRate - Speaker input sample rate in Hz (e.g. 24000 for TTS)
 * @returns An AudioAdapter for local mic I/O
 * @throws Error if VPIO binary fails to start
 */
export async function createLocalAudioAdapter(micRate: number, speakerRate: number): Promise<AudioAdapter> {
  const audioIO = await startCapture(micRate, speakerRate);
  const micStream = audioIO.micStream;
  const speakerInput: Writable = audioIO.speakerInput;

  let audioCallback: ((samples: Float32Array) => void) | null = null;

  /**
   * Subscribe to incoming audio chunks from the VPIO mic stream.
   * Converts each Buffer chunk to Float32Array and invokes the callback.
   *
   * @param callback - Called with each audio chunk as Float32Array
   */
  function onAudio(callback: (samples: Float32Array) => void): void {
    audioCallback = callback;

    micStream.on("data", (chunk: Buffer) => {
      const samples = bufferToFloat32(chunk);
      audioCallback?.(samples);
    });

    micStream.on("error", (err: Error) => {
      console.error(`Mic stream error: ${err.message}`);
    });
  }

  /**
   * Write PCM audio to the VPIO speaker stream with backpressure handling.
   *
   * @param pcm - Raw PCM buffer (16-bit signed, 24kHz mono)
   * @returns Resolves when the write completes
   */
  function writeSpeaker(pcm: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ok = speakerInput.write(pcm, (err: Error | null | undefined) => {
        if (err) reject(err);
      });
      if (ok) {
        resolve();
      } else {
        speakerInput.once("drain", () => resolve());
      }
    });
  }

  /**
   * Clear the VPIO playback buffer immediately (sends SIGUSR1).
   */
  function interrupt(): void {
    interruptPlayback();
  }

  /**
   * Resume VPIO stdin processing after an interrupt (sends SIGUSR2).
   */
  function resume(): void {
    resumePlayback();
  }

  /**
   * Play the ready chime. Fire-and-forget.
   * On macOS: uses afplay with the system Glass sound.
   * On Linux: uses paplay with a bundled WAV file.
   */
  function playChime(): void {
    if (process.platform === "linux") {
      spawn("paplay", [LINUX_CHIME_PATH]).on("error", () => {});
    } else {
      spawn("afplay", ["--volume", "6", MACOS_CHIME_PATH]).on("error", () => {});
    }
  }

  /**
   * Stop the VPIO process and free all resources.
   */
  function destroy(): void {
    stopCapture();
  }

  return {
    onAudio,
    writeSpeaker,
    interrupt,
    resume,
    playChime,
    destroy,
  };
}
