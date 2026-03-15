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

import type { Writable } from "stream";
import type { TtsPlayer, TextChunk } from "./types.js";

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

  // Pause/resume gate: the speakStream loop awaits this promise between chunks.
  // When not paused, it resolves immediately. When paused, it blocks until resume/interrupt.
  let pauseGate: Promise<void> = Promise.resolve();
  let pauseGateResolver: (() => void) | null = null;

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
      await pauseGate;
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
          await pauseGate;
          if (interruptFlag) break;

          const pcmBuffer = Buffer.from(chunk);
          const now = Date.now() - t0;
          const audioDurationMs = (pcmBuffer.length / BYTES_PER_SECOND) * 1000;
          const genMs = Date.now() - sentAt;

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
   * Pause playback without cancelling generation.
   * Creates an unresolved promise gate that suspends the speakStream loop.
   * The ElevenLabs HTTP stream continues and chunks buffer in memory.
   */
  function pause(): void {
    if (destroyed || pauseGateResolver) return;
    console.log("[tts-elevenlabs] pausing playback");
    pauseGate = new Promise<void>((resolve) => {
      pauseGateResolver = resolve;
    });
  }

  /**
   * Resume playback after a pause. Resolves the pause gate so the
   * speakStream loop wakes up and flushes buffered chunks.
   */
  function resume(): void {
    if (!pauseGateResolver) return;
    console.log("[tts-elevenlabs] resuming playback");
    pauseGateResolver();
    pauseGateResolver = null;
    pauseGate = Promise.resolve();
  }

  /**
   * Interrupt current playback and cancel in-flight generation.
   * Clears the playback buffer and sets the interrupt flag.
   * Also resolves pauseGate so the loop wakes up and hits the interruptFlag break.
   */
  function interrupt(): void {
    if (destroyed) return;
    interruptFlag = true;
    wasInterrupted = true;

    // Wake up the loop if paused so it can hit the interruptFlag break
    if (pauseGateResolver) {
      pauseGateResolver();
      pauseGateResolver = null;
      pauseGate = Promise.resolve();
    }

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
    pause,
    resume,
    interrupt,
    isSpeaking: checkIsSpeaking,
    destroy: destroyPlayer,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Write a PCM buffer to the speaker stream, respecting backpressure.
 * @param stream - The speaker writable stream
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

/** Sentence-ending punctuation pattern: .!? followed by whitespace or end */
const SENTENCE_END_RE = /[.!?][\s]+/;

/** Minimum sentence length before we'll split on punctuation */
const MIN_SENTENCE_LENGTH = 20;

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

/**
 * Read chunks from a fetch Response body as an async iterable, ensuring each
 * yielded chunk is aligned to 16-bit sample boundaries (even byte count).
 *
 * HTTP streaming splits the byte stream at arbitrary TCP packet boundaries.
 * A chunk with an odd byte count splits a 16-bit PCM sample in half. Downstream
 * consumers (browser WebSocket -> Int16Array) interpret each chunk independently,
 * so a misaligned chunk corrupts all its samples (heard as hiss/static).
 *
 * @param response - The fetch Response to read from
 * @yields Buffer chunks of sample-aligned raw PCM audio data
 */
async function* readResponseChunks(response: Response): AsyncGenerator<Buffer> {
  const body = response.body;
  if (!body) throw new Error("ElevenLabs TTS response has no body");

  const reader = body.getReader();
  let leftover: Buffer | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      let chunk: Buffer = leftover ? Buffer.concat([leftover, value]) : Buffer.from(value);
      leftover = null;

      // Hold back the last byte if odd length (split sample)
      if (chunk.byteLength % 2 !== 0) {
        leftover = Buffer.from(chunk.subarray(chunk.byteLength - 1));
        chunk = chunk.subarray(0, chunk.byteLength - 1);
      }

      if (chunk.byteLength > 0) yield chunk;
    }

    // Flush any remaining byte (only happens with malformed PCM)
    if (leftover && leftover.byteLength > 0) yield leftover;
  } finally {
    reader.releaseLock();
  }
}
