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

    const feedTask = (async () => {
      for await (const chunk of texts) {
        splitter.push(chunk);
      }
      splitter.close();
    })();

    const playTask = (async () => {
      for await (const result of tts.stream(splitter, { voice: config.voice as any })) {
        const pcmBuffer = float32ToInt16Pcm(result.audio.audio);
        await playBuffer(pcmBuffer);
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

  /**
   * Play a PCM buffer by creating a fresh Speaker, writing data with end(),
   * and waiting for the 'close' event. A new Speaker per chunk avoids
   * the buffer-underflow / hung-drain issue with long-lived Speaker instances.
   */
  function playBuffer(pcmBuffer: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const spk = createSpeaker();
      currentSpeaker = spk;

      spk.on("close", () => {
        if (currentSpeaker === spk) {
          currentSpeaker = null;
        }
        resolve();
      });

      spk.on("error", (err: Error) => {
        if (currentSpeaker === spk) {
          currentSpeaker = null;
        }
        reject(err);
      });

      // end() writes the buffer AND signals EOF -- Speaker plays then closes cleanly
      spk.end(pcmBuffer);
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS (module-level)
// ============================================================================

/**
 * Create a new Speaker instance configured for 24kHz mono 16-bit signed PCM.
 *
 * @returns A new Speaker instance
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
