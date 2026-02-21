/**
 * AudioWorklet processor for browser voice calls.
 *
 * Runs in the browser's audio rendering thread. Handles two jobs:
 * - Mic capture: accumulates input samples into chunks, posts them to main thread
 * - Speaker playback: reads from a ring buffer fed by main thread, writes to output
 *
 * Responsibilities:
 * - Buffer incoming mic audio and emit fixed-size chunks to main thread
 * - Accept playback audio from main thread and enqueue into ring buffer
 * - Provide "clear" support to flush the ring buffer on interruption
 *
 * Must be plain JavaScript -- AudioWorklet modules cannot be bundled by Vite.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** Number of mic samples to accumulate before posting to main thread */
const CHUNK_SIZE = 512;

/** Ring buffer capacity in samples (1 second at 48kHz) */
const RING_BUFFER_SIZE = 48000;

// ============================================================================
// PROCESSOR
// ============================================================================

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Mic capture buffer
    this._micBuffer = new Float32Array(CHUNK_SIZE);
    this._micBufferIndex = 0;

    // Speaker playback ring buffer
    this._ringBuffer = new Float32Array(RING_BUFFER_SIZE);
    this._readPointer = 0;
    this._writePointer = 0;

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      const { type, samples } = event.data;

      if (type === "playback" && samples) {
        this._writeToRingBuffer(samples);
      } else if (type === "clear") {
        this._readPointer = 0;
        this._writePointer = 0;
      }
    };
  }

  /**
   * Write samples into the ring buffer. Drops incoming samples on overflow
   * rather than overwriting unplayed audio.
   *
   * @param {Float32Array} samples - Audio samples to enqueue
   */
  _writeToRingBuffer(samples) {
    for (let i = 0; i < samples.length; i++) {
      const nextWrite = (this._writePointer + 1) % RING_BUFFER_SIZE;

      // Drop sample if buffer is full (write would catch up to read)
      if (nextWrite === this._readPointer) {
        return;
      }

      this._ringBuffer[this._writePointer] = samples[i];
      this._writePointer = nextWrite;
    }
  }

  /**
   * Read samples from the ring buffer into the output array.
   * Writes silence (0) when the buffer is empty.
   *
   * @param {Float32Array} output - Destination array to fill
   */
  _readFromRingBuffer(output) {
    for (let i = 0; i < output.length; i++) {
      if (this._readPointer === this._writePointer) {
        // Buffer empty -- fill remaining with silence
        output[i] = 0;
      } else {
        output[i] = this._ringBuffer[this._readPointer];
        this._readPointer = (this._readPointer + 1) % RING_BUFFER_SIZE;
      }
    }
  }

  /**
   * Called by the audio rendering thread for each 128-sample frame.
   *
   * @param {Float32Array[][]} inputs - Input audio channels (mic)
   * @param {Float32Array[][]} outputs - Output audio channels (speaker)
   * @param {Record<string, Float32Array>} parameters - AudioParam values (unused)
   * @returns {boolean} true to keep the processor alive
   */
  process(inputs, outputs, parameters) {
    // -- Mic capture: accumulate input samples and post chunks --
    const input = inputs[0];
    if (input && input[0]) {
      const inputChannel = input[0];
      for (let i = 0; i < inputChannel.length; i++) {
        this._micBuffer[this._micBufferIndex++] = inputChannel[i];

        if (this._micBufferIndex >= CHUNK_SIZE) {
          // Post a copy to main thread
          this.port.postMessage({
            type: "audio",
            samples: this._micBuffer.slice(),
          });
          this._micBufferIndex = 0;
        }
      }
    }

    // -- Speaker playback: read from ring buffer into output --
    const output = outputs[0];
    if (output && output[0]) {
      this._readFromRingBuffer(output[0]);
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
