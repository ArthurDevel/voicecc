/**
 * Tests that the AudioWorklet processor plays back all TTS audio without
 * dropping samples, regardless of chunk size or arrival timing.
 *
 * Loads the actual audio-processor.js and exercises it through the same
 * postMessage/process interface the browser uses. Tests outcomes only --
 * no assumptions about internal buffering strategy.
 *
 * Run: npx tsx --test sidecar/browser-audio-playback.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// HARNESS -- stub browser AudioWorklet APIs so we can load audio-processor.js
// ============================================================================

function loadProcessor(): {
  postMessage: (data: Record<string, unknown>) => void;
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
} {
  const source = readFileSync(join(__dirname, "../dashboard/public/audio-processor.js"), "utf-8");

  let ProcessorClass: any;

  // Stub globals that audio-processor.js expects
  const globals = {
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((event: { data: Record<string, unknown> }) => void) | null,
        postMessage(_data: unknown) {},
      };
    },
    registerProcessor(_name: string, cls: any) {
      ProcessorClass = cls;
    },
  };

  const fn = new Function(...Object.keys(globals), source);
  fn(...Object.values(globals));

  const instance = new ProcessorClass();

  return {
    postMessage(data: Record<string, unknown>) {
      instance.port.onmessage?.({ data });
    },
    process(inputs: Float32Array[][], outputs: Float32Array[][]) {
      return instance.process(inputs, outputs, {});
    },
  };
}

// ============================================================================
// TESTS
// ============================================================================

/**
 * Simulates the exact scenario from the logs:
 *   chunk 0: 2.0s audio at 24kHz -> 96,000 samples at 48kHz
 *   chunk 1: 3.0s audio at 24kHz -> 144,000 samples at 48kHz
 *
 * Both chunks arrive within ~500ms. The process() callback drains 128
 * samples per frame. Between the two chunk arrivals, only ~24,000 samples
 * drain -- far less than the total audio.
 *
 * All 240,000 samples should be played back with no drops.
 */
test("all TTS audio plays back without drops across multi-second chunks", () => {
  const proc = loadProcessor();
  const BROWSER_RATE = 48_000;
  const FRAME_SIZE = 128;

  // Chunk 0: 2s at 48kHz, filled with 0.5
  const chunk0 = new Float32Array(2.0 * BROWSER_RATE);
  chunk0.fill(0.5);

  // Chunk 1: 3s at 48kHz, filled with 0.3
  const chunk1 = new Float32Array(3.0 * BROWSER_RATE);
  chunk1.fill(0.3);

  const totalSamples = chunk0.length + chunk1.length; // 240,000

  // Post chunk 0
  proc.postMessage({ type: "playback", samples: chunk0 });

  // Simulate ~500ms of process() draining between chunk arrivals
  const framesBetweenChunks = Math.floor((0.5 * BROWSER_RATE) / FRAME_SIZE);
  let totalNonSilent = 0;

  for (let i = 0; i < framesBetweenChunks; i++) {
    const output = new Float32Array(FRAME_SIZE);
    proc.process([[new Float32Array(FRAME_SIZE)]], [[output]]);
    for (let j = 0; j < output.length; j++) {
      if (output[j] !== 0) totalNonSilent++;
    }
  }

  // Post chunk 1
  proc.postMessage({ type: "playback", samples: chunk1 });

  // Drain until we get a full frame of silence (queue exhausted)
  let silentFrames = 0;
  while (silentFrames < 3) {
    const output = new Float32Array(FRAME_SIZE);
    proc.process([[new Float32Array(FRAME_SIZE)]], [[output]]);

    let frameSilent = true;
    for (let j = 0; j < output.length; j++) {
      if (output[j] !== 0) {
        totalNonSilent++;
        frameSilent = false;
      }
    }
    silentFrames = frameSilent ? silentFrames + 1 : 0;
  }

  assert.equal(
    totalNonSilent, totalSamples,
    `Expected all ${totalSamples} samples (${(totalSamples / BROWSER_RATE).toFixed(1)}s) to play back, ` +
    `but only ${totalNonSilent} (${(totalNonSilent / BROWSER_RATE).toFixed(1)}s) were non-silent. ` +
    `${totalSamples - totalNonSilent} samples were dropped.`
  );
});

/**
 * Verifies that "clear" discards all pending audio immediately.
 * After clear, process() should output silence.
 */
test("clear discards all pending audio", () => {
  const proc = loadProcessor();
  const FRAME_SIZE = 128;

  proc.postMessage({ type: "playback", samples: new Float32Array(100_000).fill(0.5) });
  proc.postMessage({ type: "clear" });

  const output = new Float32Array(FRAME_SIZE);
  proc.process([[new Float32Array(FRAME_SIZE)]], [[output]]);

  for (let i = 0; i < output.length; i++) {
    assert.equal(output[i], 0, `Expected silence at index ${i} after clear`);
  }
});
