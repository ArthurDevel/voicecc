/**
 * ElevenLabs STT provider via batch transcription API (Scribe v2).
 *
 * Accumulates audio samples locally during speech, then sends the full buffer
 * to the ElevenLabs speech-to-text API on transcribe(). Audio is encoded as a
 * WAV file (16kHz mono 16-bit PCM) before upload.
 *
 * Responsibilities:
 * - Accumulate Float32Array audio chunks during speech
 * - Encode accumulated audio as a WAV file for upload
 * - POST the WAV to the ElevenLabs batch STT API via multipart/form-data
 * - Parse the JSON response and return a TranscriptionResult
 * - Clear the buffer after transcription or on demand
 */

import type { SttProcessor } from "./stt.js";
import type { TranscriptionResult } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** ElevenLabs STT API endpoint */
const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** Sample rate for the WAV file (must match input audio from microphone) */
const WAV_SAMPLE_RATE = 16000;

/** Number of audio channels */
const WAV_CHANNELS = 1;

/** Bits per sample in the WAV file */
const WAV_BIT_DEPTH = 16;

/** Size of the WAV file header in bytes */
const WAV_HEADER_SIZE = 44;

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Configuration for the ElevenLabs STT provider.
 */
export interface ElevenlabsSttConfig {
  /** ElevenLabs API key for authentication */
  apiKey: string;
  /** ElevenLabs STT model ID (e.g. "scribe_v1") */
  modelId: string;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create an SttProcessor that uses the ElevenLabs batch transcription API.
 *
 * Audio is accumulated locally via accumulate(), then the full buffer is
 * encoded as WAV and sent to ElevenLabs on transcribe(). This fits the
 * existing SttProcessor interface without changes.
 *
 * @param config - ElevenLabs STT configuration (API key and model ID)
 * @returns An SttProcessor instance ready for transcription
 */
export async function createElevenlabsStt(config: ElevenlabsSttConfig): Promise<SttProcessor> {
  const { apiKey, modelId } = config;

  let audioChunks: Float32Array[] = [];

  /**
   * Append audio samples to the internal buffer.
   * @param samples - Float32Array of audio samples (16kHz, normalized -1.0 to 1.0)
   */
  function accumulate(samples: Float32Array): void {
    audioChunks.push(samples);
  }

  /**
   * Transcribe the accumulated audio buffer by sending it to the ElevenLabs API.
   * Encodes the audio as WAV, uploads via multipart/form-data, and parses the result.
   *
   * @returns Transcription result with text, isFinal flag, and timestamp
   * @throws Error on empty buffer, non-2xx response, or network failure
   */
  async function transcribe(): Promise<TranscriptionResult> {
    const combinedSamples = concatenateChunks(audioChunks);
    audioChunks = [];

    if (combinedSamples.length === 0) {
      return { text: "", isFinal: true, timestamp: Date.now() };
    }

    // Encode audio as WAV and upload to ElevenLabs
    const wavBuffer = encodeWav(combinedSamples);
    const wavBlob = new Blob([wavBuffer], { type: "audio/wav" });

    const formData = new FormData();
    formData.append("file", wavBlob, "audio.wav");
    formData.append("model_id", modelId);

    const response = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`ElevenLabs STT API error ${response.status}: ${errorText}`);
    }

    const result = await response.json() as { text: string };

    return { text: result.text.trim(), isFinal: true, timestamp: Date.now() };
  }

  /**
   * Clear the accumulated audio buffer without transcribing.
   */
  function clearBuffer(): void {
    audioChunks = [];
  }

  /**
   * Free resources. Clears the buffer (no external resources to release).
   */
  function destroy(): void {
    audioChunks = [];
  }

  return {
    accumulate,
    transcribe,
    clearBuffer,
    destroy,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Encode Float32Array audio samples as a WAV file buffer.
 * Writes a 44-byte WAV header followed by 16-bit signed PCM data.
 *
 * @param samples - Float32Array of audio samples (normalized -1.0 to 1.0)
 * @returns Buffer containing a valid WAV file
 */
function encodeWav(samples: Float32Array): Buffer {
  const bytesPerSample = WAV_BIT_DEPTH / 8;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = WAV_HEADER_SIZE + dataSize;

  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  // RIFF header
  buffer.write("RIFF", offset); offset += 4;
  buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
  buffer.write("WAVE", offset); offset += 4;

  // fmt sub-chunk
  buffer.write("fmt ", offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4;             // Sub-chunk size (16 for PCM)
  buffer.writeUInt16LE(1, offset); offset += 2;              // Audio format (1 = PCM)
  buffer.writeUInt16LE(WAV_CHANNELS, offset); offset += 2;   // Number of channels
  buffer.writeUInt32LE(WAV_SAMPLE_RATE, offset); offset += 4; // Sample rate
  buffer.writeUInt32LE(WAV_SAMPLE_RATE * WAV_CHANNELS * bytesPerSample, offset); offset += 4; // Byte rate
  buffer.writeUInt16LE(WAV_CHANNELS * bytesPerSample, offset); offset += 2; // Block align
  buffer.writeUInt16LE(WAV_BIT_DEPTH, offset); offset += 2;  // Bits per sample

  // data sub-chunk
  buffer.write("data", offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  // Convert float samples to 16-bit signed PCM
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    buffer.writeInt16LE(Math.round(int16), offset);
    offset += 2;
  }

  return buffer;
}

/**
 * Concatenate an array of Float32Array chunks into a single Float32Array.
 *
 * @param chunks - Array of Float32Array audio chunks
 * @returns Single concatenated Float32Array
 */
function concatenateChunks(chunks: Float32Array[]): Float32Array {
  if (chunks.length === 0) return new Float32Array(0);
  if (chunks.length === 1) return chunks[0];

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
