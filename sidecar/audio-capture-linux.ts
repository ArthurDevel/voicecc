/**
 * Linux audio I/O via PulseAudio/PipeWire CLI tools with echo cancellation.
 *
 * Uses two child processes: `parec` for mic capture and `pacat` for speaker
 * playback. Both target PulseAudio's `module-echo-cancel` virtual devices so
 * TTS playback is subtracted from the mic signal.
 *
 * Responsibilities:
 * - Start/stop parec and pacat processes for echo-cancelled audio I/O
 * - Provide a readable stream of echo-cancelled 16-bit signed PCM mic data
 * - Provide a stable GatedWritable for TTS audio playback that survives interrupt/resume cycles
 * - Detect required echo-cancel PulseAudio devices at startup
 * - Support playback interruption (kill pacat) and resume (respawn pacat)
 */

import { spawn, exec, type ChildProcess } from "child_process";
import { Writable } from "stream";

import type { AudioIO } from "./audio-capture.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Name of the PulseAudio echo-cancel source created by module-echo-cancel */
const ECHO_SOURCE_NAME = "voicecc_echo_source";

/** Name of the PulseAudio echo-cancel sink created by module-echo-cancel */
const ECHO_SINK_NAME = "voicecc_echo_sink";

/** Timeout for parec to produce first data chunk (ms) */
const MIC_DATA_TIMEOUT_MS = 5_000;

/** Instructions for loading the echo-cancel module */
const ECHO_CANCEL_INSTRUCTIONS =
  "Load echo cancellation with:\n" +
  "  pactl load-module module-echo-cancel aec_method=webrtc " +
  `source_name=${ECHO_SOURCE_NAME} sink_name=${ECHO_SINK_NAME}`;

// ============================================================================
// INTERFACES
// ============================================================================

/** Internal state for the Linux audio capture session */
interface LinuxAudioState {
  parecProcess: ChildProcess | null;
  pacatProcess: ChildProcess | null;
  speakerGate: GatedWritable;
  discarding: boolean;
  echoSourceName: string;
  echoSinkName: string;
  speakerRate: number;
}

// ============================================================================
// GATED WRITABLE
// ============================================================================

/**
 * Custom Writable that forwards writes to the current pacat stdin.
 *
 * Provides a stable reference for callers while allowing the underlying
 * pacat process to be killed and respawned during interrupt/resume cycles.
 *
 * In normal mode, _write() forwards data to pacat stdin with backpressure.
 * In discard mode, _write() drops data silently so callers never block.
 */
class GatedWritable extends Writable {
  private pacatStdin: Writable | null = null;
  private discarding: boolean = false;

  /**
   * Forward chunks to pacat stdin, or discard if in discard mode.
   *
   * @param chunk - PCM audio data
   * @param encoding - Buffer encoding (ignored for binary data)
   * @param callback - Callback to signal write completion
   */
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.discarding || !this.pacatStdin) {
      callback();
      return;
    }

    // Forward data to pacat stdin. The callback form handles both completion
    // and errors. If pacat was killed mid-write, swallow the error in discard mode.
    this.pacatStdin.write(chunk, (err) => {
      if (err && this.discarding) {
        // Pacat was killed mid-write (e.g. during interrupt) -- swallow
        callback();
      } else if (err) {
        callback(err);
      } else {
        callback();
      }
    });
  }

  /**
   * Swap the internal pacat stdin reference to a new process.
   *
   * @param newStdin - The stdin Writable of the newly spawned pacat process
   */
  setPacatStdin(newStdin: Writable): void {
    this.pacatStdin = newStdin;
  }

  /**
   * Enable or disable discard mode.
   * When true, all writes are dropped silently. Errors from a dying pacat stdin
   * are swallowed to prevent ERR_STREAM_DESTROYED from propagating.
   *
   * @param value - true to discard, false to resume forwarding
   */
  setDiscarding(value: boolean): void {
    this.discarding = value;
    if (value && this.pacatStdin) {
      // Swallow any errors from the old (possibly killed) pacat stdin
      this.pacatStdin.on("error", () => {});
    }
  }
}

// ============================================================================
// STATE
// ============================================================================

let state: LinuxAudioState | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start Linux audio I/O with echo cancellation via parec and pacat.
 *
 * Validates that required CLI tools and PulseAudio echo-cancel devices exist
 * before spawning processes. Returns a stable AudioIO whose speakerInput
 * survives interrupt/resume cycles.
 *
 * @param micRate - Mic output sample rate in Hz (e.g. 16000)
 * @param speakerRate - Speaker input sample rate in Hz (e.g. 24000)
 * @returns AudioIO with parec stdout as micStream and GatedWritable as speakerInput
 * @throws Error if parec/pacat not found, echo-cancel devices not loaded, or mic produces no data
 */
async function startCaptureLinux(micRate: number, speakerRate: number): Promise<AudioIO> {
  // Check required CLI tools
  const hasParec = await commandExists("parec");
  const hasPacat = await commandExists("pacat");
  if (!hasParec || !hasPacat) {
    throw new Error(
      "parec and/or pacat not found. Install with: sudo apt install pulseaudio-utils"
    );
  }

  // Detect echo-cancel source and sink
  const hasSource = await detectEchoDevice("source", ECHO_SOURCE_NAME);
  if (!hasSource) {
    throw new Error(
      `Echo-cancel source '${ECHO_SOURCE_NAME}' not found.\n${ECHO_CANCEL_INSTRUCTIONS}`
    );
  }

  const hasSink = await detectEchoDevice("sink", ECHO_SINK_NAME);
  if (!hasSink) {
    throw new Error(
      `Echo-cancel sink '${ECHO_SINK_NAME}' not found.\n${ECHO_CANCEL_INSTRUCTIONS}`
    );
  }

  // Spawn parec for mic capture targeting the echo-cancel source
  const parecProcess = spawn("parec", [
    `--device=${ECHO_SOURCE_NAME}`,
    "--format=s16le",
    `--rate=${micRate}`,
    "--channels=1",
    "--raw",
  ]);

  if (!parecProcess.stdout) {
    throw new Error("Failed to get parec stdout stream");
  }

  // Spawn pacat for speaker playback targeting the echo-cancel sink
  const pacatProcess = spawn("pacat", [
    `--device=${ECHO_SINK_NAME}`,
    "--format=s16le",
    `--rate=${speakerRate}`,
    "--channels=1",
    "--raw",
    "--playback",
  ]);

  if (!pacatProcess.stdin) {
    parecProcess.kill();
    throw new Error("Failed to get pacat stdin stream");
  }

  // Create the gated writable and wire it to pacat stdin
  const speakerGate = new GatedWritable();
  speakerGate.setPacatStdin(pacatProcess.stdin);

  // Store state for stop/interrupt/resume
  state = {
    parecProcess,
    pacatProcess,
    speakerGate,
    discarding: false,
    echoSourceName: ECHO_SOURCE_NAME,
    echoSinkName: ECHO_SINK_NAME,
    speakerRate,
  };

  // Validate parec produces data within timeout
  await waitForMicData(parecProcess);

  // Set up error/exit handlers
  setupParecHandlers(parecProcess);
  setupPacatHandlers(pacatProcess);

  return {
    micStream: parecProcess.stdout,
    speakerInput: speakerGate,
  };
}

/**
 * Stop Linux audio I/O and free all resources.
 *
 * Sets discard mode first to prevent ERR_STREAM_DESTROYED on in-flight writes,
 * then kills both child processes.
 */
function stopCaptureLinux(): void {
  if (!state) return;

  // Discard first to prevent write errors during teardown
  state.speakerGate.setDiscarding(true);
  state.discarding = true;

  if (state.parecProcess) {
    state.parecProcess.kill();
    state.parecProcess = null;
  }

  if (state.pacatProcess) {
    state.pacatProcess.kill();
    state.pacatProcess = null;
  }

  state = null;
}

/**
 * Interrupt current speaker playback by killing the pacat process.
 *
 * Sets discard mode on the GatedWritable so in-flight and future writes
 * are dropped silently. Killing pacat closes the PulseAudio stream,
 * stopping playback with ~20-50ms latency from the daemon's internal buffer.
 */
function interruptPlaybackLinux(): void {
  if (!state) return;

  state.speakerGate.setDiscarding(true);
  state.discarding = true;

  if (state.pacatProcess) {
    state.pacatProcess.kill();
    state.pacatProcess = null;
  }
}

/**
 * Resume speaker playback after an interrupt.
 *
 * Spawns a fresh pacat process targeting the stored echo-cancel sink,
 * wires it into the GatedWritable, and clears discard mode so new
 * audio flows through.
 */
function resumePlaybackLinux(): void {
  if (!state) return;

  const newPacat = spawn("pacat", [
    `--device=${state.echoSinkName}`,
    "--format=s16le",
    `--rate=${state.speakerRate}`,
    "--channels=1",
    "--raw",
    "--playback",
  ]);

  if (newPacat.stdin) {
    state.speakerGate.setPacatStdin(newPacat.stdin);
  }

  state.pacatProcess = newPacat;
  state.discarding = false;
  state.speakerGate.setDiscarding(false);

  setupPacatHandlers(newPacat);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check whether a command exists on the system PATH.
 * Uses `command -v` for portability (works on all POSIX shells).
 *
 * @param cmd - The command name to check
 * @returns true if the command exists, false otherwise
 */
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    exec(`command -v ${cmd}`, (error) => {
      resolve(error === null);
    });
  });
}

/**
 * Detect whether a PulseAudio echo-cancel device exists.
 * Runs `pactl list short sources` or `pactl list short sinks` and checks
 * if the given device name appears in the output.
 *
 * @param type - "source" for mic sources, "sink" for playback sinks
 * @param name - The exact device name to search for (e.g. "voicecc_echo_source")
 * @returns true if the device name was found in pactl output
 */
function detectEchoDevice(type: "source" | "sink", name: string): Promise<boolean> {
  const pactlArg = type === "source" ? "sources" : "sinks";
  return new Promise((resolve) => {
    exec(`pactl list short ${pactlArg}`, (error, stdout) => {
      if (error) {
        resolve(false);
        return;
      }
      // Check each line for the exact device name as a tab-separated field
      const lines = stdout.split("\n");
      const found = lines.some((line) => {
        const fields = line.split("\t");
        return fields.some((field) => field.trim() === name);
      });
      resolve(found);
    });
  });
}

/**
 * Wait for parec to produce at least one data chunk within a timeout.
 * Similar to the macOS waitForReady pattern -- validates that the mic
 * capture process is actually working before returning to the caller.
 *
 * @param proc - The parec child process
 * @returns Resolves when first data chunk arrives
 * @throws Error if parec produces no data within the timeout or exits early
 */
function waitForMicData(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `parec produced no audio data within ${MIC_DATA_TIMEOUT_MS}ms. ` +
            "Check that your microphone is connected and PulseAudio/PipeWire is running."
        )
      );
    }, MIC_DATA_TIMEOUT_MS);

    const onData = () => {
      clearTimeout(timeout);
      proc.stdout!.off("data", onData);
      proc.off("error", onError);
      proc.off("exit", onExit);
      resolve();
    };

    const onError = (err: Error) => {
      clearTimeout(timeout);
      reject(new Error(`parec failed to start: ${err.message}`));
    };

    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      reject(new Error(`parec exited with code ${code} before producing data`));
    };

    proc.stdout!.on("data", onData);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });
}

/**
 * Set up error and exit handlers on the parec (mic capture) process.
 * If parec exits unexpectedly, emits an error on its stdout so the voice
 * session shuts down cleanly.
 *
 * @param proc - The parec child process
 */
function setupParecHandlers(proc: ChildProcess): void {
  proc.on("error", (err) => {
    console.error(`[parec] process error: ${err.message}`);
    if (proc.stdout) {
      proc.stdout.destroy(new Error(`parec process error: ${err.message}`));
    }
  });

  proc.on("exit", (code, signal) => {
    // If state is null, we're in a clean shutdown -- ignore
    if (!state) return;

    console.error(
      `[parec] exited unexpectedly (code=${code}, signal=${signal}). ` +
        "Mic capture lost. The echo-cancel module may have been unloaded."
    );

    // Emit error on micStream so the voice session shuts down
    if (proc.stdout) {
      proc.stdout.destroy(
        new Error(
          `parec exited unexpectedly (code=${code}, signal=${signal}). ` +
            "Check that PulseAudio/PipeWire is running and module-echo-cancel is loaded."
        )
      );
    }
  });

  // Log stderr output for diagnostics
  if (proc.stderr) {
    proc.stderr.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) console.log(`[parec] ${trimmed}`);
      }
    });
  }
}

/**
 * Set up error and exit handlers on the pacat (speaker playback) process.
 * If pacat exits outside of an explicit interrupt, logs a warning and
 * attempts to respawn.
 *
 * @param proc - The pacat child process
 */
function setupPacatHandlers(proc: ChildProcess): void {
  proc.on("error", (err) => {
    console.error(`[pacat] process error: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    // If state is null, we're in a clean shutdown -- ignore
    if (!state) return;

    // If discarding, this is an expected exit from interrupt -- do not respawn
    if (state.discarding) return;

    console.warn(
      `[pacat] exited unexpectedly (code=${code}, signal=${signal}). Attempting respawn.`
    );

    // Attempt to respawn pacat
    resumePlaybackLinux();
  });

  // Log stderr output for diagnostics
  if (proc.stderr) {
    proc.stderr.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        const trimmed = line.trim();
        if (trimmed) console.log(`[pacat] ${trimmed}`);
      }
    });
  }
}

export {
  startCaptureLinux,
  stopCaptureLinux,
  interruptPlaybackLinux,
  resumePlaybackLinux,
};
