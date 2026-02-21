/**
 * Test that reproduces browser audio playback truncation.
 *
 * The AudioWorklet ring buffer is 48,000 samples (1s at 48kHz). TTS chunks
 * are typically 2-5s of audio. After upsampling from 24kHz to the browser's
 * 48kHz sample rate, a single chunk can be 96,000-240,000 samples. The ring
 * buffer silently drops everything past capacity, so the user only hears the
 * first ~1 second of each chunk.
 *
 * Run: npx tsx --test sidecar/browser-audio-playback.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

// ============================================================================
// RING BUFFER -- exact replica of audio-processor.js logic
// ============================================================================

const RING_BUFFER_SIZE = 48_000; // matches audio-processor.js

class RingBuffer {
  buffer: Float32Array;
  readPointer: number;
  writePointer: number;

  constructor(size: number) {
    this.buffer = new Float32Array(size);
    this.readPointer = 0;
    this.writePointer = 0;
  }

  /** Identical to AudioProcessor._writeToRingBuffer */
  write(samples: Float32Array): number {
    let written = 0;
    for (let i = 0; i < samples.length; i++) {
      const nextWrite = (this.writePointer + 1) % RING_BUFFER_SIZE;
      if (nextWrite === this.readPointer) {
        return written;
      }
      this.buffer[this.writePointer] = samples[i];
      this.writePointer = nextWrite;
      written++;
    }
    return written;
  }

  /** Identical to AudioProcessor._readFromRingBuffer */
  read(output: Float32Array): void {
    for (let i = 0; i < output.length; i++) {
      if (this.readPointer === this.writePointer) {
        output[i] = 0;
      } else {
        output[i] = this.buffer[this.readPointer];
        this.readPointer = (this.readPointer + 1) % RING_BUFFER_SIZE;
      }
    }
  }

  available(): number {
    return (this.writePointer - this.readPointer + RING_BUFFER_SIZE) % RING_BUFFER_SIZE;
  }
}

// ============================================================================
// TESTS
// ============================================================================

/**
 * Simulates the exact scenario from the logs:
 *   chunk 0: 2.0s audio at 24kHz -> 96,000 samples at 48kHz
 *   chunk 1: 3.0s audio at 24kHz -> 144,000 samples at 48kHz
 *
 * Both chunks arrive within ~500ms. The AudioWorklet's process() callback
 * drains 128 samples every ~2.67ms (48kHz / 128). Between the two chunk
 * arrivals, only ~24,000 samples drain -- nowhere near enough to make room.
 *
 * Expected outcome: all 240,000 samples should be playable.
 */
test("BUG: ring buffer drops audio when TTS chunks exceed 1-second capacity", () => {
  const ring = new RingBuffer(RING_BUFFER_SIZE);
  const BROWSER_RATE = 48_000;
  const FRAME_SIZE = 128; // AudioWorklet quantum

  // Chunk 0: 2s of audio at 24kHz, upsampled to 48kHz = 96,000 samples
  const chunk0 = new Float32Array(2.0 * BROWSER_RATE);
  chunk0.fill(0.5);

  // Chunk 1: 3s of audio at 24kHz, upsampled to 48kHz = 144,000 samples
  const chunk1 = new Float32Array(3.0 * BROWSER_RATE);
  chunk1.fill(0.3);

  const totalSamples = chunk0.length + chunk1.length; // 240,000

  // Write chunk 0 to ring buffer (simulates browser onmessage -> worklet postMessage)
  const written0 = ring.write(chunk0);

  // Simulate ~500ms of process() draining between chunks (realistic inter-chunk gap).
  // 500ms at 48kHz / 128 per frame = ~187 frames = ~24,000 samples drained.
  const framesBetweenChunks = Math.floor((0.5 * BROWSER_RATE) / FRAME_SIZE);
  let totalDrained = 0;
  const frame = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < framesBetweenChunks; i++) {
    ring.read(frame);
    totalDrained += FRAME_SIZE;
  }

  // Write chunk 1
  const written1 = ring.write(chunk1);

  // Drain remaining
  while (ring.available() > 0) {
    ring.read(frame);
    totalDrained += FRAME_SIZE;
  }

  const totalWritten = written0 + written1;

  assert.equal(
    totalWritten, totalSamples,
    `Ring buffer accepted ${totalWritten}/${totalSamples} samples ` +
    `(${(totalWritten / BROWSER_RATE).toFixed(1)}s of ${(totalSamples / BROWSER_RATE).toFixed(1)}s). ` +
    `${totalSamples - totalWritten} samples (${((totalSamples - totalWritten) / BROWSER_RATE).toFixed(1)}s) were silently dropped. ` +
    `The ${RING_BUFFER_SIZE}-sample ring buffer (${(RING_BUFFER_SIZE / BROWSER_RATE).toFixed(1)}s at ${BROWSER_RATE}Hz) ` +
    `cannot hold multi-second TTS chunks.`
  );
});
