/**
 * Local text-to-speech via mlx-audio (Chatterbox Turbo) with speaker playback.
 *
 * Spawns a persistent Python subprocess (tts-server.py) that loads the TTS model
 * once on the Apple Silicon GPU via MLX, then generates audio on demand. Text is
 * buffered into sentences before being sent to the subprocess. Audio is received
 * as length-prefixed raw PCM and played through the `speaker` npm package.
 *
 * Responsibilities:
 * - Spawn and manage the tts-server.py Python subprocess lifecycle
 * - Buffer streaming text deltas into complete sentences for generation
 * - Read length-prefixed PCM audio chunks from the subprocess stdout
 * - Play audio through Speaker with interruption support
 */

import { ChildProcess, spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Speaker from "speaker";

import type { TtsConfig } from "./types.js";

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
   * @returns Resolves when playback completes
   */
  speak(text: string): Promise<void>;

  /**
   * Stream text chunks into TTS for incremental playback.
   * First audio plays while later chunks are still generating.
   * @param texts - Async iterable of text chunks to speak
   * @returns Resolves when all chunks have been spoken
   */
  speakStream(texts: AsyncIterable<string>): Promise<void>;

  /**
   * Interrupt current playback immediately.
   * Destroys the current Speaker and cancels in-progress generation.
   */
  interrupt(): void;

  /**
   * Check whether audio is currently playing.
   * @returns true if audio is being played through the speaker
   */
  isSpeaking(): boolean;

  /**
   * Free all TTS model resources and destroy the speaker.
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
 * @param config - TTS configuration (model ID, optional reference audio)
 * @returns A TtsPlayer instance ready for playback
 * @throws Error if subprocess fails to start or model fails to load
 */
export async function createTts(config: TtsConfig): Promise<TtsPlayer> {
  const args = [TTS_SERVER_SCRIPT, config.model, config.voice];

  const proc = spawn(PYTHON_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for READY on stderr
  await waitForReady(proc);

  let currentSpeaker: Speaker | null = null;
  let destroyed = false;

  /**
   * Generate audio for a single text string and play it.
   * @param text - The text to speak
   */
  async function speak(text: string): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    sendCommand(proc, { cmd: "generate", text });

    const spk = createSpeaker();
    currentSpeaker = spk;

    try {
      await readAndPlayChunks(proc, spk, () => currentSpeaker === spk);
      await endAndWait(spk);
    } catch (err) {
      if (currentSpeaker === spk) throw err;
    } finally {
      if (currentSpeaker === spk) currentSpeaker = null;
    }
  }

  /**
   * Stream text chunks into TTS for pipelined playback.
   * Buffers text deltas into sentences, generates audio per sentence,
   * and plays while the next sentence generates.
   * @param texts - Async iterable of text chunks from the narrator
   */
  async function speakStream(texts: AsyncIterable<string>): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    const t0 = Date.now();
    let firstTextLogged = false;
    let spk: Speaker | null = null;
    let chunkIndex = 0;
    let lastChunkReadyAt = 0;

    for await (const sentence of bufferSentences(texts)) {
      if (!firstTextLogged) {
        console.log(`[tts] first sentence at +${Date.now() - t0}ms: "${sentence.slice(0, 50)}${sentence.length > 50 ? "..." : ""}"`);
        firstTextLogged = true;
      }

      // Send generate command for this sentence
      sendCommand(proc, { cmd: "generate", text: sentence });

      // Read and play audio chunks for this sentence
      const playOneChunk = (pcmBuffer: Buffer, isFirst: boolean) => {
        const now = Date.now() - t0;
        const audioDurationMs =
          (pcmBuffer.length / (TTS_SAMPLE_RATE * (SPEAKER_BIT_DEPTH / 8) * SPEAKER_CHANNELS)) * 1000;
        const genTimeMs = now - lastChunkReadyAt;
        console.log(
          `[tts] chunk ${chunkIndex} ready at +${now}ms (${(audioDurationMs / 1000).toFixed(1)}s audio, generated in ${(genTimeMs / 1000).toFixed(1)}s)`
        );
        lastChunkReadyAt = now;
        chunkIndex++;

        if (isFirst && !spk) {
          spk = createSpeaker();
          currentSpeaker = spk;
          spk.cork();
          spk.write(pcmBuffer);
          spk.uncork();
          return;
        }

        if (currentSpeaker !== spk) return;
        spk!.write(pcmBuffer);
      };

      // Read all chunks for this sentence
      let isFirstChunk = spk === null;
      for await (const pcmBuffer of readPcmChunks(proc)) {
        if (spk && currentSpeaker !== spk) break; // interrupted
        playOneChunk(pcmBuffer, isFirstChunk);
        isFirstChunk = false;
      }

      if (spk && currentSpeaker !== spk) break; // interrupted
    }

    // Signal end of playback
    if (spk && currentSpeaker === spk) {
      try {
        await endAndWait(spk);
      } catch {
        // Swallow errors from speaker destroyed mid-playback (interruption)
      } finally {
        if (currentSpeaker === spk) currentSpeaker = null;
      }
    }
  }

  /**
   * Interrupt current playback and generation immediately.
   */
  function interrupt(): void {
    if (destroyed) return;
    sendCommand(proc, { cmd: "interrupt" });
    if (currentSpeaker) {
      currentSpeaker.destroy();
      currentSpeaker = null;
    }
  }

  function checkIsSpeaking(): boolean {
    return currentSpeaker !== null;
  }

  /**
   * Free all resources: kill the Python subprocess and destroy the speaker.
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
 * Async generator that reads length-prefixed PCM chunks from the subprocess stdout.
 * Yields Buffer objects until a 0-length end marker is received.
 * @param proc - The child process to read from
 * @yields Buffer of raw 16-bit signed PCM audio
 */
async function* readPcmChunks(proc: ChildProcess): AsyncGenerator<Buffer> {
  const stdout = proc.stdout!;

  while (true) {
    // Read 4-byte length header
    const header = await readExactly(stdout, 4);
    const length = header.readUInt32BE(0);

    // 0-length = end of generation
    if (length === 0) return;

    // Read the PCM data
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

    const tryRead = () => {
      while (received < size) {
        const remaining = size - received;
        const chunk = (stream as any).read(remaining) as Buffer | null;
        if (chunk === null) {
          // Not enough data yet, wait for more
          stream.once("readable", tryRead);
          return;
        }
        chunks.push(chunk);
        received += chunk.length;
      }

      // Got all bytes
      const result = Buffer.concat(chunks);
      resolve(result.subarray(0, size));
    };

    (stream as any).once("error", reject);
    (stream as any).once("end", () => reject(new Error("Stream ended before reading enough bytes")));

    tryRead();
  });
}

/**
 * Read PCM chunks and write them to a Speaker for a single generation.
 * Used by the speak() method.
 * @param proc - The child process to read from
 * @param spk - The Speaker to write to
 * @param isActive - Function that returns false if interrupted
 */
async function readAndPlayChunks(
  proc: ChildProcess,
  spk: Speaker,
  isActive: () => boolean
): Promise<void> {
  let first = true;
  for await (const pcmBuffer of readPcmChunks(proc)) {
    if (!isActive()) break;

    if (first) {
      spk.cork();
      spk.write(pcmBuffer);
      spk.uncork();
      first = false;
    } else {
      await writeChunk(spk, pcmBuffer);
    }
  }
}

/**
 * Buffer streaming text deltas into complete sentences for TTS generation.
 * Splits on sentence-ending punctuation (.!?) followed by whitespace.
 * @param texts - Async iterable of text chunks from the narrator
 * @yields Complete sentences ready for TTS
 */
async function* bufferSentences(texts: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";

  for await (const chunk of texts) {
    buffer += chunk;

    // Try to extract complete sentences from the buffer
    while (buffer.length >= MIN_SENTENCE_LENGTH) {
      const match = SENTENCE_END_RE.exec(buffer.slice(MIN_SENTENCE_LENGTH - 1));
      if (!match) break;

      const splitIndex = MIN_SENTENCE_LENGTH - 1 + match.index + match[0].length;
      const sentence = buffer.slice(0, splitIndex).trim();
      buffer = buffer.slice(splitIndex);

      if (sentence) yield sentence;
    }
  }

  // Flush remaining text
  const remaining = buffer.trim();
  if (remaining) yield remaining;
}

/**
 * Write a chunk to an open Speaker, respecting backpressure.
 * @param spk - The Speaker instance
 * @param pcmBuffer - Raw PCM bytes to write
 */
function writeChunk(spk: Speaker, pcmBuffer: Buffer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = spk.write(pcmBuffer, (err: Error | null | undefined) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      spk.once("drain", () => resolve());
    }
  });
}

/**
 * Signal EOF and wait for the Speaker to finish playing and close.
 * @param spk - The Speaker instance
 */
function endAndWait(spk: Speaker): Promise<void> {
  return new Promise<void>((resolve) => {
    spk.on("close", () => resolve());
    spk.end();
  });
}

/**
 * Create a new Speaker instance configured for 24kHz mono 16-bit signed PCM.
 * @returns A new Speaker instance
 */
function createSpeaker(): Speaker {
  return new Speaker({
    channels: SPEAKER_CHANNELS,
    bitDepth: SPEAKER_BIT_DEPTH,
    sampleRate: TTS_SAMPLE_RATE,
  });
}
