/**
 * ElevenLabs TTS provider via streaming HTTP API.
 *
 * Calls the ElevenLabs text-to-speech streaming endpoint to generate audio,
 * then writes raw PCM chunks to the speaker stream for playback. No subprocess
 * is needed -- audio is fetched over HTTP and piped directly into the pipeline.
 *
 * Responsibilities:
 * - POST text to the ElevenLabs TTS streaming API and receive chunked PCM audio
 * - Buffer streaming text deltas into sentences via shared bufferSentences utility
 * - Write PCM audio to the speaker stream with backpressure handling
 * - Track playback timing and wait for audio to finish before resolving
 * - Support interruption by cancelling in-flight requests and clearing playback
 */

import { bufferSentences, writePcm } from "./tts.js";

import type { Writable } from "stream";
import type { TtsPlayer } from "./tts.js";
import type { TextChunk } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** ElevenLabs TTS streaming API base URL */
const ELEVENLABS_TTS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";

/** PCM output sample rate in Hz (must match speaker pipeline) */
const TTS_SAMPLE_RATE = 24000;

/** Speaker audio bit depth */
const SPEAKER_BIT_DEPTH = 16;

/** Speaker channel count */
const SPEAKER_CHANNELS = 1;

/** Bytes per second of PCM audio at 24kHz 16-bit mono */
const BYTES_PER_SECOND = TTS_SAMPLE_RATE * (SPEAKER_BIT_DEPTH / 8) * SPEAKER_CHANNELS;

/** Interval (ms) for checking the interrupt flag during playback wait */
const INTERRUPT_CHECK_INTERVAL_MS = 50;

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Configuration for the ElevenLabs TTS provider.
 */
export interface ElevenlabsTtsConfig {
  /** ElevenLabs API key for authentication */
  apiKey: string;
  /** ElevenLabs voice ID to use for generation */
  voiceId: string;
  /** ElevenLabs model ID (e.g. "eleven_monolingual_v1") */
  modelId: string;
  /** Writable stream for PCM audio output */
  speakerInput: Writable;
  /** Callback to clear the playback buffer on interruption */
  interruptPlayback: () => void;
  /** Callback to resume playback after an interrupt */
  resumePlayback: () => void;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create a TtsPlayer that uses the ElevenLabs streaming TTS API.
 *
 * Sends text to the ElevenLabs API and receives raw PCM audio at 24kHz 16-bit
 * mono, which is written directly to the speaker stream. No format conversion
 * is needed since the output matches the speaker pipeline exactly.
 *
 * @param config - ElevenLabs TTS configuration (API key, voice, model, speaker stream)
 * @returns A TtsPlayer instance ready for playback
 */
export async function createElevenlabsTts(config: ElevenlabsTtsConfig): Promise<TtsPlayer> {
  const { apiKey, voiceId, modelId, speakerInput, interruptPlayback, resumePlayback } = config;

  let destroyed = false;
  let speaking = false;
  let interruptFlag = false;
  let wasInterrupted = false;

  /**
   * POST text to the ElevenLabs TTS streaming endpoint and stream PCM chunks
   * to the speaker. Returns the total number of PCM bytes written.
   *
   * @param text - The text to synthesize
   * @returns Total PCM bytes written to the speaker stream
   */
  async function streamTtsToSpeaker(text: string): Promise<number> {
    const url = `${ELEVENLABS_TTS_BASE_URL}/${voiceId}/stream?output_format=pcm_24000`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({ text, model_id: modelId }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown error");
      throw new Error(`ElevenLabs TTS API error ${response.status}: ${errorText}`);
    }

    let totalBytes = 0;

    for await (const chunk of readResponseChunks(response)) {
      if (interruptFlag) break;

      const pcmBuffer = Buffer.from(chunk);
      totalBytes += pcmBuffer.length;
      await writePcm(speakerInput, pcmBuffer);
    }

    return totalBytes;
  }

  /**
   * Wait for the estimated remaining playback time, allowing interruption to cancel.
   *
   * @param remainingMs - Milliseconds to wait for playback to finish
   */
  function waitForPlayback(remainingMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remainingMs);

      // Poll the interrupt flag to allow early cancellation
      const check = setInterval(() => {
        if (interruptFlag) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, INTERRUPT_CHECK_INTERVAL_MS);

      // Clean up interval when timer fires naturally
      setTimeout(() => clearInterval(check), remainingMs + 100);
    });
  }

  /**
   * Generate audio for a single text string via ElevenLabs API and play it.
   * @param text - The text to speak
   */
  async function speak(text: string): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    interruptFlag = false;
    speaking = true;

    if (wasInterrupted) {
      resumePlayback();
      wasInterrupted = false;
    }

    try {
      await streamTtsToSpeaker(text);
    } finally {
      speaking = false;
    }
  }

  /**
   * Stream text chunks into TTS for pipelined playback.
   * Buffers text deltas into sentences, generates audio per sentence via
   * the ElevenLabs API, and writes PCM to the speaker stream.
   * @param texts - Async iterable of text chunks from the narrator
   */
  async function speakStream(texts: AsyncIterable<TextChunk>): Promise<void> {
    if (destroyed) throw new Error("TtsPlayer has been destroyed");

    const t0 = Date.now();
    let firstTextLogged = false;
    let chunkIndex = 0;
    let playbackFinishAt = 0;

    interruptFlag = false;
    speaking = true;

    if (wasInterrupted) {
      resumePlayback();
      wasInterrupted = false;
    }

    try {
      for await (const sentence of bufferSentences(texts)) {
        if (interruptFlag) break;

        if (!firstTextLogged) {
          console.log(`[tts-elevenlabs] first sentence at +${Date.now() - t0}ms: "${sentence.slice(0, 50)}${sentence.length > 50 ? "..." : ""}"`);
          firstTextLogged = true;
        }

        const sentAt = Date.now();

        // Fetch streamed PCM from ElevenLabs
        const url = `${ELEVENLABS_TTS_BASE_URL}/${voiceId}/stream?output_format=pcm_24000`;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey,
          },
          body: JSON.stringify({ text: sentence, model_id: modelId }),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          throw new Error(`ElevenLabs TTS API error ${response.status}: ${errorText}`);
        }

        if (interruptFlag) break;

        // Read chunked PCM from the response body
        for await (const chunk of readResponseChunks(response)) {
          if (interruptFlag) break;

          const pcmBuffer = Buffer.from(chunk);
          const now = Date.now() - t0;
          const audioDurationMs = (pcmBuffer.length / BYTES_PER_SECOND) * 1000;
          const genMs = Date.now() - sentAt;

          console.log(
            `[tts-elevenlabs] chunk ${chunkIndex} at +${now}ms (${(audioDurationMs / 1000).toFixed(1)}s audio, generated in ${genMs}ms)`
          );
          chunkIndex++;

          await writePcm(speakerInput, pcmBuffer);

          // Track estimated playback end. If the speaker buffer drained during a
          // gap (e.g. tool call), new audio starts from now, not after previous audio.
          playbackFinishAt = Math.max(playbackFinishAt, Date.now()) + audioDurationMs;
        }

        if (interruptFlag) break;
      }

      // Wait for buffered audio to finish playing through the speakers
      if (!interruptFlag && playbackFinishAt > 0) {
        const remainingMs = playbackFinishAt - Date.now();
        if (remainingMs > 0) {
          console.log(`[tts-elevenlabs] waiting ${(remainingMs / 1000).toFixed(1)}s for playback to finish`);
          await waitForPlayback(remainingMs);
        }
      }
    } finally {
      speaking = false;
    }
  }

  /**
   * Interrupt current playback and cancel in-flight generation.
   * Clears the playback buffer and sets the interrupt flag.
   */
  function interrupt(): void {
    if (destroyed) return;
    interruptFlag = true;
    wasInterrupted = true;
    interruptPlayback();
  }

  /**
   * Check whether TTS is currently active.
   * @returns true if a speak/speakStream call is in progress
   */
  function checkIsSpeaking(): boolean {
    return speaking;
  }

  /**
   * Free all resources and prevent further usage.
   */
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
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read chunks from a fetch Response body as an async iterable.
 * The response body is a ReadableStream of Uint8Array chunks.
 *
 * @param response - The fetch Response to read from
 * @yields Uint8Array chunks of raw PCM audio data
 */
async function* readResponseChunks(response: Response): AsyncGenerator<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error("ElevenLabs TTS response has no body");

  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
