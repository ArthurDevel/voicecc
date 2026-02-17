/**
 * Local speech-to-text via sherpa-onnx with Whisper ONNX model (offline/batch).
 *
 * Whisper models in sherpa-onnx are offline-only (not streaming). Audio is
 * accumulated during speech (SPEECH_START to SPEECH_END), then batch-transcribed
 * on SPEECH_END using `createOfflineRecognizer`.
 *
 * Responsibilities:
 * - Load the sherpa-onnx offline recognizer with a Whisper ONNX model
 * - Accumulate audio samples during speech into an internal buffer
 * - Batch-transcribe the accumulated buffer on demand
 * - Manage buffer and recognizer lifecycle
 */

import { existsSync } from "fs";
import type { TranscriptionResult } from "./types.js";

// ============================================================================
// INTERFACES
// ============================================================================

/** Internal interface for the STT processor returned by createStt. */
interface SttProcessor {
  /**
   * Appends audio samples to the internal buffer.
   * Call continuously during speech (between SPEECH_START and SPEECH_END).
   *
   * @param samples - Float32Array of audio samples (16kHz, normalized -1.0 to 1.0)
   */
  accumulate(samples: Float32Array): void;

  /**
   * Batch-transcribes the accumulated audio buffer using the offline recognizer.
   * Creates an offline stream, feeds the accumulated audio, decodes, and returns
   * the result. Clears the buffer afterward.
   *
   * @returns Transcription result with text, isFinal flag, and timestamp
   */
  transcribe(): Promise<TranscriptionResult>;

  /**
   * Clears the accumulated audio buffer without transcribing.
   * Use on interruption or when discarding a speech segment.
   */
  clearBuffer(): void;

  /**
   * Frees the underlying recognizer resources.
   * Call on shutdown to prevent resource leaks.
   */
  destroy(): void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Sample rate expected by the Whisper model */
const SAMPLE_RATE = 16000;

/** Default model file prefix (sherpa-onnx naming convention: "small.en", "tiny.en", etc.) */
const DEFAULT_MODEL_PREFIX = "small.en";

/** Required model file suffixes within the model directory */
const REQUIRED_SUFFIXES = ["-encoder.int8.onnx", "-decoder.int8.onnx", "-tokens.txt"];

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Loads the sherpa-onnx offline recognizer with the Whisper model at the given
 * path and returns an SttProcessor.
 *
 * @param modelPath - Path to directory containing encoder.onnx, decoder.onnx, and tokens.txt
 * @returns Promise resolving to an SttProcessor instance
 * @throws Error if any required model files are missing
 */
async function createStt(modelPath: string): Promise<SttProcessor> {
  validateModelFiles(modelPath);

  // Dynamic import to avoid ONNX runtime conflict with kokoro-js.
  // Both sherpa-onnx-node and kokoro-js bundle native ONNX runtimes that
  // crash if loaded simultaneously via static imports.
  const sherpa = (await import("sherpa-onnx-node")).default;

  const prefix = DEFAULT_MODEL_PREFIX;
  const config = {
    modelConfig: {
      whisper: {
        encoder: `${modelPath}/${prefix}-encoder.int8.onnx`,
        decoder: `${modelPath}/${prefix}-decoder.int8.onnx`,
      },
      tokens: `${modelPath}/${prefix}-tokens.txt`,
    },
  };

  const recognizer = new sherpa.OfflineRecognizer(config);

  // Buffer stored as array of chunks to avoid repeated copying during accumulation
  let audioChunks: Float32Array[] = [];

  return {
    accumulate(samples: Float32Array): void {
      audioChunks.push(samples);
    },

    async transcribe(): Promise<TranscriptionResult> {
      const combinedSamples = concatenateChunks(audioChunks);
      audioChunks = [];

      if (combinedSamples.length === 0) {
        return { text: "", isFinal: true, timestamp: Date.now() };
      }

      // Create a fresh stream, feed audio, decode
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: combinedSamples });
      recognizer.decode(stream);

      const result = recognizer.getResult(stream);
      const text = result.text.trim();

      return { text, isFinal: true, timestamp: Date.now() };
    },

    clearBuffer(): void {
      audioChunks = [];
    },

    destroy(): void {
      audioChunks = [];
      // recognizer cleanup is handled by sherpa-onnx-node garbage collection
    },
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validates that all required model files exist in the given directory.
 *
 * @param modelPath - Path to the model directory
 * @throws Error with details about which files are missing
 */
function validateModelFiles(modelPath: string): void {
  if (!existsSync(modelPath)) {
    throw new Error(
      `STT model directory not found: ${modelPath}. ` +
        `Download a Whisper ONNX model and place encoder.onnx, decoder.onnx, and tokens.txt in this directory.`
    );
  }

  const expectedFiles = REQUIRED_SUFFIXES.map((suffix) => `${DEFAULT_MODEL_PREFIX}${suffix}`);
  const missingFiles = expectedFiles.filter(
    (file) => !existsSync(`${modelPath}/${file}`)
  );

  if (missingFiles.length > 0) {
    throw new Error(
      `Missing STT model files in ${modelPath}: ${missingFiles.join(", ")}. ` +
        `Required files: ${expectedFiles.join(", ")}.`
    );
  }
}

/**
 * Concatenates an array of Float32Array chunks into a single Float32Array.
 * Avoids repeated copying during accumulation by deferring concatenation
 * until transcription time.
 *
 * @param chunks - Array of Float32Array audio chunks
 * @returns Single concatenated Float32Array
 */
function concatenateChunks(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 0) {
    return new Float32Array(0);
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

export { createStt };
export type { SttProcessor };
