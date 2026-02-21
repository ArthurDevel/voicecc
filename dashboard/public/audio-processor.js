/**
 * AudioWorklet processor for browser voice calls.
 *
 * Runs in the browser's audio rendering thread. Handles two jobs:
 * - Mic capture: accumulates input samples into chunks, posts them to main thread
 * - Speaker playback: reads from a chunk queue fed by main thread, writes to output
 *
 * Responsibilities:
 * - Buffer incoming mic audio and emit fixed-size chunks to main thread
 * - Accept playback audio from main thread and enqueue into chunk queue
 * - Provide "clear" support to flush the chunk queue on interruption
 *
 * Must be plain JavaScript -- AudioWorklet modules cannot be bundled by Vite.
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** Number of mic samples to accumulate before posting to main thread */
const CHUNK_SIZE = 512;

// ============================================================================
// PROCESSOR
// ============================================================================

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Mic capture buffer
    this._micBuffer = new Float32Array(CHUNK_SIZE);
    this._micBufferIndex = 0;

    // Speaker playback chunk queue
    this._chunks = [];
    this._chunkIndex = 0; // read position within current chunk

    // Handle messages from main thread
    this.port.onmessage = (event) => {
      const { type, samples } = event.data;

      if (type === "playback" && samples) {
        this._chunks.push(samples);
      } else if (type === "clear") {
        this._chunks.length = 0;
        this._chunkIndex = 0;
      }
    };
  }

  /**
   * Read samples from the chunk queue into the output array.
   * Writes silence (0) when the queue is empty.
   *
   * @param {Float32Array} output - Destination array to fill
   */
  _readFromQueue(output) {
    let written = 0;

    while (written < output.length) {
      if (this._chunks.length === 0) {
        // Queue empty -- fill remaining with silence
        for (let i = written; i < output.length; i++) {
          output[i] = 0;
        }
        return;
      }

      const chunk = this._chunks[0];
      const available = chunk.length - this._chunkIndex;
      const needed = output.length - written;
      const toCopy = Math.min(available, needed);

      for (let i = 0; i < toCopy; i++) {
        output[written++] = chunk[this._chunkIndex++];
      }

      if (this._chunkIndex >= chunk.length) {
        this._chunks.shift();
        this._chunkIndex = 0;
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

    // -- Speaker playback: read from chunk queue into output (mono -> all channels) --
    const output = outputs[0];
    if (output && output[0]) {
      this._readFromQueue(output[0]);
      for (let ch = 1; ch < output.length; ch++) {
        output[ch].set(output[0]);
      }
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
