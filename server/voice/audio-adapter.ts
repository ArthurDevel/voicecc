/**
 * AudioAdapter interface for abstracting audio I/O in voice sessions.
 *
 * Any audio transport (local mic, Twilio, WhatsApp) implements this interface
 * so the voice session logic remains transport-agnostic.
 *
 * Responsibilities:
 * - Define a common contract for audio input (microphone) and output (speaker)
 * - Support playback interruption and resumption
 * - Provide a ready chime signal
 * - Clean up resources on destroy
 */

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Abstraction over audio I/O for the voice session.
 * Implemented by local-audio.ts (VPIO) and twilio-audio.ts (WebSocket).
 */
export interface AudioAdapter {
  /**
   * Subscribe to incoming audio chunks from the microphone.
   * The callback receives Float32Array samples (16kHz, normalized -1.0 to 1.0).
   * The callback is synchronous -- the consumer wraps async work internally.
   *
   * @param callback - Called with each audio chunk as Float32Array
   */
  onAudio: (callback: (samples: Float32Array) => void) => void;

  /**
   * Write PCM audio to the speaker output.
   * Audio format: 16-bit signed, 24kHz mono.
   *
   * @param pcm - Raw PCM buffer to play
   * @returns Resolves when the write completes (backpressure)
   */
  writeSpeaker: (pcm: Buffer) => Promise<void>;

  /**
   * Clear the output audio buffer immediately (user interruption).
   */
  interrupt: () => void;

  /**
   * Resume output after an interrupt. Must be called before writing new audio.
   */
  resume: () => void;

  /**
   * Play the ready chime through the output.
   */
  playChime: () => void;

  /**
   * Clean up all resources (kill processes, close connections).
   */
  destroy: () => void;
}
