/**
 * Local text-to-speech via kokoro-js with speaker playback.
 *
 * Converts text to audio using the Kokoro TTS model (ONNX, runs locally) and
 * plays it through the system speakers via the `speaker` npm package. Kokoro-js
 * outputs Float32Array at 24kHz; this module converts to 16-bit signed PCM for
 * speaker output.
 *
 * Responsibilities:
 * - Initialize the kokoro-js TTS model (downloads from HuggingFace on first use)
 * - Generate audio from text (single-shot and streaming via TextSplitterStream)
 * - Convert Float32Array audio to 16-bit signed PCM for speaker output
 * - Manage Speaker lifecycle (create, write, destroy) with interruption support
 * - Track playback state (isSpeaking)
 */

import { KokoroTTS, TextSplitterStream } from "kokoro-js";
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
   * Destroys the current Speaker and creates a fresh one.
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

/** Kokoro-js HuggingFace model identifier */
const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/** Kokoro-js output sample rate in Hz */
const TTS_SAMPLE_RATE = 24000;

/** Speaker audio configuration */
const SPEAKER_CHANNELS = 1;
const SPEAKER_BIT_DEPTH = 16;

/** Multiplier for converting float samples (-1.0..1.0) to 16-bit signed integers */
const PCM_16BIT_MAX = 32767;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Initialize the kokoro-js TTS engine and create a TtsPlayer instance.
 *
 * Downloads the model from HuggingFace on first use. Creates an initial
 * Speaker instance configured for 24kHz mono 16-bit signed PCM.
 *
 * @param config - TTS configuration (voice ID, model variant)
 * @returns A TtsPlayer instance ready for playback
 * @throws Error if model download or initialization fails
 */
export async function createTts(config: TtsConfig): Promise<TtsPlayer> {
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
    dtype: config.modelVariant as "fp32" | "fp16" | "q8" | "q4" | "q4f16",
  });

  let currentSpeaker: Speaker | null = null;
  let destroyed = false;

  async function speak(text: string): Promise<void> {
    if (destroyed) {
      throw new Error("TtsPlayer has been destroyed");
    }

    const audio = await tts.generate(text, { voice: config.voice as any });
    const pcmBuffer = float32ToInt16Pcm(audio.audio);

    await playBuffer(pcmBuffer);
  }

  async function speakStream(texts: AsyncIterable<string>): Promise<void> {
    if (destroyed) {
      throw new Error("TtsPlayer has been destroyed");
    }

    const splitter = new TextSplitterStream();

    // Don't create Speaker yet -- defer until first audio chunk is ready
    // to avoid CoreAudio buffer underflow while waiting for Claude + TTS.
    let spk: Speaker | null = null;

    // Feed text into the splitter in the background
    const t0 = Date.now();
    let firstTextLogged = false;
    let totalText = "";
    const feedTask = (async () => {
      try {
        for await (const chunk of texts) {
          if (!firstTextLogged) {
            console.log(`[tts] first text at +${Date.now() - t0}ms`);
            firstTextLogged = true;
          }
          totalText += chunk;
          splitter.push(chunk);
        }
      } finally {
        console.log(`[tts] splitter.close() at +${Date.now() - t0}ms (${totalText.length} chars)`);
        splitter.close();
      }
    })();

    // tts.stream() pipelines generation: while chunk N plays, chunk N+1 generates
    let chunkIndex = 0;
    let lastChunkReadyAt = 0;
    const playTask = (async () => {
      try {
        for await (const result of tts.stream(splitter, { voice: config.voice as any })) {
          const pcmBuffer = float32ToInt16Pcm(result.audio.audio);
          const now = Date.now() - t0;
          const audioDurationMs = (pcmBuffer.length / (TTS_SAMPLE_RATE * (SPEAKER_BIT_DEPTH / 8) * SPEAKER_CHANNELS)) * 1000;
          const genTimeMs = now - lastChunkReadyAt;
          console.log(`[tts] chunk ${chunkIndex} ready at +${now}ms (${(audioDurationMs / 1000).toFixed(1)}s audio, generated in ${(genTimeMs / 1000).toFixed(1)}s)`);
          lastChunkReadyAt = now;

          // First chunk: cork → write → uncork so the Speaker's native _open()
          // and first AudioQueueEnqueueBuffer happen in the same _write() call.
          // This eliminates the CoreAudio "buffer underflow" race.
          if (!spk) {
            spk = createSpeaker();
            currentSpeaker = spk;
            spk.cork();
            spk.write(pcmBuffer);
            spk.uncork();
            chunkIndex++;
            continue;
          }

          if (currentSpeaker !== spk) break; // interrupted
          await writeChunk(spk, pcmBuffer);
          chunkIndex++;
        }

        // Signal no more data and wait for playback to finish
        if (spk && currentSpeaker === spk) {
          await endAndWait(spk);
        }
      } catch (err) {
        // Swallow errors from speaker destroyed mid-write (interruption)
        if (spk && currentSpeaker === spk) throw err;
      }
    })();

    await Promise.all([feedTask, playTask]);
  }

  function interrupt(): void {
    if (destroyed) return;
    if (currentSpeaker) {
      currentSpeaker.destroy();
      currentSpeaker = null;
    }
  }

  function checkIsSpeaking(): boolean {
    return currentSpeaker !== null;
  }

  function destroyPlayer(): void {
    if (destroyed) return;
    destroyed = true;
    interrupt();
  }

  return {
    speak,
    speakStream,
    interrupt,
    isSpeaking: checkIsSpeaking,
    destroy: destroyPlayer,
  };

  /** Play a single buffer with a fresh Speaker (used by speak()). */
  function playBuffer(pcmBuffer: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const spk = createSpeaker();
      currentSpeaker = spk;

      spk.on("close", () => {
        if (currentSpeaker === spk) currentSpeaker = null;
        resolve();
      });

      spk.on("error", (err: Error) => {
        if (currentSpeaker === spk) currentSpeaker = null;
        reject(err);
      });

      spk.end(pcmBuffer);
    });
  }

  /** Write a chunk to an open Speaker, respecting backpressure. */
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

  /** Signal EOF and wait for the Speaker to finish playing and close. */
  function endAndWait(spk: Speaker): Promise<void> {
    return new Promise<void>((resolve) => {
      spk.on("close", () => {
        if (currentSpeaker === spk) currentSpeaker = null;
        resolve();
      });
      spk.end();
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS (module-level)
// ============================================================================

/**
 * Create a new Speaker instance configured for 24kHz mono 16-bit signed PCM.
 *
 * @returns A new Speaker instance (not yet opened — device opens on first write)
 */
function createSpeaker(): Speaker {
  return new Speaker({
    channels: SPEAKER_CHANNELS,
    bitDepth: SPEAKER_BIT_DEPTH,
    sampleRate: TTS_SAMPLE_RATE,
  });
}

/**
 * Convert a Float32Array of audio samples (-1.0..1.0) to a 16-bit signed PCM Buffer.
 *
 * Each float sample is clamped to the -1.0..1.0 range, then scaled to the
 * 16-bit signed integer range (-32767..32767).
 *
 * @param float32 - Float32Array of normalized audio samples from kokoro-js
 * @returns Buffer containing 16-bit signed little-endian PCM data
 */
function float32ToInt16Pcm(float32: Float32Array): Buffer {
  const int16 = new Int16Array(float32.length);

  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = clamped * PCM_16BIT_MAX;
  }

  return Buffer.from(int16.buffer);
}
