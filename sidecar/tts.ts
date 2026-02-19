/**
 * Local text-to-speech via mlx-audio (Chatterbox Turbo) with VPIO playback.
 *
 * Spawns a persistent Python subprocess (tts-server.py) that loads the TTS model
 * once on the Apple Silicon GPU via MLX, then generates audio on demand. Text is
 * buffered into sentences before being sent to the subprocess. Audio is received
 * as length-prefixed raw PCM and written to the VPIO speaker stream for playback
 * with echo cancellation.
 *
 * Responsibilities:
 * - Spawn and manage the tts-server.py Python subprocess lifecycle
 * - Buffer streaming text deltas into complete sentences for generation
 * - Read length-prefixed PCM audio chunks from the subprocess stdout
 * - Write audio to the VPIO speaker stream (echo cancellation handled by VPIO)
 * - Support interruption via VPIO ring buffer clear
 */

import { ChildProcess, spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import type { Writable } from "stream";
import type { TtsConfig, TextChunk } from "./types.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * TTS player instance that converts text to spoken audio output.
 */
export interface TtsPlayer {
  /**
   * Convert text to audio and play it through the speakers.
   * @param text - The text to speak
   * @returns Resolves when all PCM has been sent to the speaker stream
   */
  speak(text: string): Promise<void>;

  /**
   * Stream text chunks into TTS for incremental playback.
   * First audio plays while later chunks are still generating.
   * @param texts - Async iterable of text chunks (plain string = buffer, { text, flush } = immediate)
   * @returns Resolves when all chunks have been sent to the speaker stream
   */
  speakStream(texts: AsyncIterable<TextChunk>): Promise<void>;

  /**
   * Interrupt current playback immediately.
   * Clears the VPIO ring buffer and cancels in-progress generation.
   */
  interrupt(): void;

  /**
   * Check whether TTS is currently generating and playing audio.
   * @returns true if a speak/speakStream call is active
   */
  isSpeaking(): boolean;

  /**
   * Free all TTS model resources and kill the subprocess.
   */
  destroy(): void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** TTS output sample rate in Hz (Chatterbox outputs at 24kHz) */
const TTS_SAMPLE_RATE = 24000;

/** Speaker audio configuration */
const SPEAKER_CHANNELS = 1;
const SPEAKER_BIT_DEPTH = 16;

/** Path to the Python TTS server script */
const __dirname = dirname(fileURLToPath(import.meta.url));
const TTS_SERVER_SCRIPT = join(__dirname, "tts-server.py");

/** Path to the Python venv binary */
const PYTHON_BIN = join(__dirname, ".venv", "bin", "python3");

/** Timeout for waiting for the Python subprocess to be ready (ms) */
const READY_TIMEOUT_MS = 120_000;

/** Sentence-ending punctuation pattern: .!? followed by whitespace or end */
const SENTENCE_END_RE = /[.!?][\s]+/;

/** Minimum sentence length before we'll split on punctuation */
const MIN_SENTENCE_LENGTH = 20;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Initialize the mlx-audio TTS subprocess and create a TtsPlayer instance.
 *
 * Spawns tts-server.py which loads the model on the Apple Silicon GPU.
 * First run downloads the model from HuggingFace (~3GB for fp16).
 *
 * @param config - TTS configuration (model ID, voice, speaker stream, interrupt callback)
 * @returns A TtsPlayer instance ready for playback
 * @throws Error if subprocess fails to start or model fails to load
 */
export async function createTts(config: TtsConfig): Promise<TtsPlayer> {
  const cmd = config.serverCommand ?? [PYTHON_BIN, TTS_SERVER_SCRIPT, config.model, config.voice];

  const proc = spawn(cmd[0], cmd.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await waitForReady(proc);

  const { speakerInput, interruptPlayback, resumePlayback } = config;
  let destroyed = false;
  let speaking = false;
  let interruptFlag = false;
  let wasInterrupted = false;
  let midGeneration = false;

  /**
   * Generate audio for a single text string and play it.
   * @param text - The text to speak
   */
  async function speak(text: string): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    interruptFlag = false;
    speaking = true;
    if (wasInterrupted) {
      if (midGeneration) {
        await drainStaleChunks(proc);
        midGeneration = false;
      }
      resumePlayback();
      wasInterrupted = false;
    }

    sendCommand(proc, { cmd: "generate", text });
    midGeneration = true;

    try {
      for await (const pcmBuffer of readPcmChunks(proc)) {
        if (interruptFlag) break;
        await writePcm(speakerInput, pcmBuffer);
      }
      if (!interruptFlag) midGeneration = false;
    } finally {
      speaking = false;
    }
  }

  /**
   * Stream text chunks into TTS for pipelined playback.
   * Buffers text deltas into sentences, generates audio per sentence,
   * and writes PCM to the VPIO speaker stream.
   * @param texts - Async iterable of text chunks from the narrator
   */
  async function speakStream(texts: AsyncIterable<TextChunk>): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    const t0 = Date.now();
    let firstTextLogged = false;
    let chunkIndex = 0;
    let firstWriteAt = 0;
    let totalAudioMs = 0;

    interruptFlag = false;
    speaking = true;
    if (wasInterrupted) {
      if (midGeneration) {
        await drainStaleChunks(proc);
        midGeneration = false;
      }
      resumePlayback();
      wasInterrupted = false;
    }

    try {
      for await (const sentence of bufferSentences(texts)) {
        if (interruptFlag) break;

        if (!firstTextLogged) {
          console.log(`[tts] first sentence at +${Date.now() - t0}ms: "${sentence.slice(0, 50)}${sentence.length > 50 ? "..." : ""}"`);
          firstTextLogged = true;
        }

        const sentAt = Date.now();
        sendCommand(proc, { cmd: "generate", text: sentence });
        midGeneration = true;

        for await (const pcmBuffer of readPcmChunks(proc)) {
          if (interruptFlag) break;

          const now = Date.now() - t0;
          const audioDurationMs =
            (pcmBuffer.length / (TTS_SAMPLE_RATE * (SPEAKER_BIT_DEPTH / 8) * SPEAKER_CHANNELS)) * 1000;
          const genMs = Date.now() - sentAt;
          console.log(
            `[tts] chunk ${chunkIndex} at +${now}ms (${(audioDurationMs / 1000).toFixed(1)}s audio, generated in ${genMs}ms)`
          );
          chunkIndex++;

          if (firstWriteAt === 0) firstWriteAt = Date.now();
          totalAudioMs += audioDurationMs;

          await writePcm(speakerInput, pcmBuffer);
        }

        if (!interruptFlag) midGeneration = false;
        if (interruptFlag) break;
      }

      // Wait for buffered audio to finish playing through the speakers
      if (!interruptFlag && firstWriteAt > 0) {
        const elapsedSinceFirstWrite = Date.now() - firstWriteAt;
        const remainingMs = totalAudioMs - elapsedSinceFirstWrite;
        if (remainingMs > 0) {
          console.log(`[tts] waiting ${(remainingMs / 1000).toFixed(1)}s for playback to finish`);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, remainingMs);
            // Allow interruption to cancel the wait
            const check = setInterval(() => {
              if (interruptFlag) {
                clearTimeout(timer);
                clearInterval(check);
                resolve();
              }
            }, 50);
            // Clean up interval when timer fires naturally
            setTimeout(() => clearInterval(check), remainingMs + 100);
          });
        }
      }
    } finally {
      speaking = false;
    }
  }

  /**
   * Interrupt current playback and generation immediately.
   * Clears the VPIO ring buffer and cancels TTS generation.
   */
  function interrupt(): void {
    if (destroyed) return;
    interruptFlag = true;
    wasInterrupted = true;
    interruptPlayback();
    sendCommand(proc, { cmd: "interrupt" });
  }

  /**
   * Check whether TTS is currently active.
   */
  function checkIsSpeaking(): boolean {
    return speaking;
  }

  /**
   * Free all resources: kill the Python subprocess.
   */
  function destroyPlayer(): void {
    if (destroyed) return;
    destroyed = true;
    interrupt();
    sendCommand(proc, { cmd: "quit" });
    proc.kill("SIGTERM");
  }

  return {
    speak,
    speakStream,
    interrupt,
    isSpeaking: checkIsSpeaking,
    destroy: destroyPlayer,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Wait for the Python subprocess to print READY on stderr.
 * @param proc - The child process to monitor
 * @throws Error if the subprocess exits or times out before READY
 */
function waitForReady(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`tts-server.py did not become ready within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    let stderrBuffer = "";

    const onData = (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;

      // Log all stderr output (model download progress, etc.)
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && trimmed !== "READY") {
          console.log(`[tts-server] ${trimmed}`);
        }
      }

      if (stderrBuffer.includes("READY")) {
        clearTimeout(timeout);
        proc.stderr!.off("data", onData);

        // Continue logging stderr after READY
        proc.stderr!.on("data", (d: Buffer) => {
          for (const line of d.toString().split("\n")) {
            const trimmed = line.trim();
            if (trimmed) console.log(`[tts-server] ${trimmed}`);
          }
        });

        resolve();
      }
    };

    proc.stderr!.on("data", onData);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`tts-server.py failed to start: ${err.message}`));
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`tts-server.py exited with code ${code} before READY`));
    });
  });
}

/**
 * Send a JSON command to the Python subprocess stdin.
 * @param proc - The child process
 * @param cmd - The command object to send
 */
function sendCommand(proc: ChildProcess, cmd: Record<string, unknown>): void {
  proc.stdin!.write(JSON.stringify(cmd) + "\n");
}

/**
 * Drain stale PCM data from the subprocess stdout after an interruption.
 * Reads and discards remaining chunks until the end marker (0-length frame).
 * @param proc - The child process to drain from
 */
async function drainStaleChunks(proc: ChildProcess): Promise<void> {
  for await (const _chunk of readPcmChunks(proc)) {
    // Discard stale chunks until end marker
  }
}

/**
 * Async generator that reads length-prefixed PCM chunks from the subprocess stdout.
 * Yields Buffer objects until a 0-length end marker is received.
 * @param proc - The child process to read from
 * @yields Buffer of raw 16-bit signed PCM audio
 */
async function* readPcmChunks(proc: ChildProcess): AsyncGenerator<Buffer> {
  const stdout = proc.stdout!;

  while (true) {
    const header = await readExactly(stdout, 4);
    const length = header.readUInt32BE(0);

    if (length === 0) return;

    const pcmData = await readExactly(stdout, length);
    yield pcmData;
  }
}

/**
 * Read exactly N bytes from a readable stream.
 * @param stream - The readable stream
 * @param size - Number of bytes to read
 * @returns Buffer containing exactly size bytes
 */
function readExactly(stream: NodeJS.ReadableStream, size: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;

    const onError = (err: Error) => {
      stream.removeListener("end", onEnd);
      reject(err);
    };

    const onEnd = () => {
      stream.removeListener("error", onError);
      reject(new Error("Stream ended before reading enough bytes"));
    };

    const tryRead = () => {
      while (received < size) {
        const remaining = size - received;
        const chunk = (stream as any).read(remaining) as Buffer | null;
        if (chunk === null) {
          stream.once("readable", tryRead);
          return;
        }
        chunks.push(chunk);
        received += chunk.length;
      }

      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      const result = Buffer.concat(chunks);
      resolve(result.subarray(0, size));
    };

    stream.once("error", onError);
    stream.once("end", onEnd);

    tryRead();
  });
}

/**
 * Write a PCM buffer to the speaker stream, respecting backpressure.
 * @param stream - The VPIO speaker writable stream
 * @param pcmBuffer - Raw PCM bytes to write
 */
function writePcm(stream: Writable, pcmBuffer: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = stream.write(pcmBuffer, (err: Error | null | undefined) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      stream.once("drain", () => resolve());
    }
  });
}

/**
 * Buffer streaming text deltas into complete sentences for TTS generation.
 * Chunks tagged with { flush: true } are yielded immediately (e.g. tool narration).
 * Plain string chunks are buffered and split on sentence-ending punctuation.
 * @param texts - Async iterable of TextChunk from the narrator
 * @yields Complete sentences ready for TTS
 */
async function* bufferSentences(texts: AsyncIterable<TextChunk>): AsyncGenerator<string> {
  let buffer = "";

  for await (const raw of texts) {
    if (typeof raw !== "string") {
      if (buffer.trim()) {
        yield buffer.trim();
        buffer = "";
      }
      yield raw.text;
      continue;
    }

    buffer += raw;

    while (buffer.length >= MIN_SENTENCE_LENGTH) {
      const match = SENTENCE_END_RE.exec(buffer.slice(MIN_SENTENCE_LENGTH - 1));
      if (!match) break;

      const splitIndex = MIN_SENTENCE_LENGTH - 1 + match.index + match[0].length;
      const sentence = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex);

      if (sentence) yield sentence;
    }
  }

  const remaining = buffer.trim();
  if (remaining) yield remaining;
}
