/**
 * Tests that decodeChimeToPcm produces clean audio without artifacts.
 *
 * The chime PCM is sent directly to the browser as raw int16 samples.
 * If the buffer contains file-format headers, they get played as loud
 * garbage ("bop") before the actual chime.
 *
 * Run: npx tsx --test sidecar/chime.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { decodeChimeToPcm } from "./chime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Sample rate of the decoded chime */
const CHIME_RATE = 24000;

/**
 * Max acceptable amplitude for the first 10ms of the chime.
 * Glass.aiff fades in from silence, so early samples should be near-zero.
 * A value above this means non-audio data (e.g. file headers) is present.
 */
const MAX_AMPLITUDE_FIRST_10MS = 500;

// ============================================================================
// TESTS
// ============================================================================

/**
 * The chime starts quietly -- the Glass.aiff sound fades in from silence.
 * If the first samples contain large values, the buffer has non-audio data
 * (file-format headers) that would be heard as a loud pop/bop.
 */
test("chime PCM starts with near-silent samples (no file header artifacts)", () => {
  const buf = decodeChimeToPcm();
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);

  const samplesIn10ms = Math.floor(CHIME_RATE * 0.01);

  let maxAmplitude = 0;
  for (let i = 0; i < samplesIn10ms; i++) {
    maxAmplitude = Math.max(maxAmplitude, Math.abs(int16[i]));
  }

  assert.ok(
    maxAmplitude < MAX_AMPLITUDE_FIRST_10MS,
    `First 10ms of chime has amplitude ${maxAmplitude} (limit: ${MAX_AMPLITUDE_FIRST_10MS}). ` +
    `This likely means file-format header bytes are being included as audio data.`
  );
});

/**
 * The decoded chime should contain roughly 1-2 seconds of audio.
 * If the buffer is much larger, it likely includes a large file header.
 * If much smaller, the decoding failed.
 */
test("chime PCM has a plausible duration for Glass.aiff", () => {
  const buf = decodeChimeToPcm();
  const sampleCount = buf.byteLength / 2; // int16 = 2 bytes per sample
  const durationSec = sampleCount / CHIME_RATE;

  assert.ok(durationSec > 0.5, `Chime too short: ${durationSec.toFixed(2)}s`);
  assert.ok(durationSec < 3.0, `Chime too long: ${durationSec.toFixed(2)}s -- may contain header data`);
});
