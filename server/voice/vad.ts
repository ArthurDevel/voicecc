/**
 * Voice Activity Detection (VAD) via avr-vad (Silero VAD v5).
 *
 * Wraps the avr-vad callback-based API into a simpler event queue model.
 * avr-vad handles its own framing internally (512-sample frames at 16kHz).
 * We feed raw audio via processAudio and collect speech events from callbacks.
 *
 * Responsibilities:
 * - Initialize the Silero VAD v5 model
 * - Feed raw audio and collect speech start/end events
 * - Expose per-frame probability via onFrameProcessed callback
 * - Manage model lifecycle (reset between utterances, destroy on shutdown)
 */

import type { VadEvent, VadEventType } from "./types.js";

// ============================================================================
// INTERFACES
// ============================================================================

/** Callback invoked for each VAD event detected in the audio stream. */
type VadEventCallback = (event: VadEvent) => void;

/** Internal interface for the VAD processor returned by createVad. */
interface VadProcessor {
  /**
   * Feed raw audio samples to the VAD. avr-vad handles framing internally.
   * Events are emitted via the callback provided at creation.
   *
   * @param samples - Float32Array of audio samples (16kHz, normalized -1.0 to 1.0)
   */
  processAudio(samples: Float32Array): Promise<void>;

  /**
   * Resets internal VAD state. Call between utterances to avoid
   * state leakage across speech segments.
   */
  reset(): void;

  /**
   * Frees the underlying ONNX model resources.
   * Call on shutdown to prevent resource leaks.
   */
  destroy(): void;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Initializes the Silero VAD v5 model via avr-vad and returns a VadProcessor.
 * Events (SPEECH_START, SPEECH_END, etc.) are delivered via the onEvent callback.
 *
 * @param onEvent - Callback invoked for each detected VAD event
 * @returns Promise resolving to a VadProcessor instance
 * @throws Error if the ONNX model fails to load
 */
async function createVad(onEvent: VadEventCallback): Promise<VadProcessor> {
  // Dynamic import to avoid ONNX runtime conflict with kokoro-js.
  const { RealTimeVAD } = await import("avr-vad");

  let lastProbability = 0;

  const vad = await RealTimeVAD.new({
    onSpeechStart: () => {
      onEvent({ type: "SPEECH_START", probability: lastProbability, timestamp: Date.now() });
    },
    onSpeechRealStart: () => {
      // Emitted after minSpeechFrames confirm real speech.
      // We treat this as SPEECH_CONTINUE to signal sustained speech.
      onEvent({ type: "SPEECH_CONTINUE", probability: lastProbability, timestamp: Date.now() });
    },
    onSpeechEnd: () => {
      onEvent({ type: "SPEECH_END", probability: lastProbability, timestamp: Date.now() });
    },
    onFrameProcessed: (probs: { isSpeech: number }) => {
      lastProbability = probs.isSpeech;
    },
  });

  // Must call start() to activate processing
  vad.start();

  return {
    async processAudio(samples: Float32Array): Promise<void> {
      await vad.processAudio(samples);
    },

    reset(): void {
      vad.reset();
    },

    destroy(): void {
      vad.destroy();
    },
  };
}

export { createVad };
export type { VadProcessor, VadEventCallback };
