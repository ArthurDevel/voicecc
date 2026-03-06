/**
 * Tests that ElevenLabs TTS writes sample-aligned PCM to the speaker stream.
 *
 * ElevenLabs streams raw PCM (16-bit, 24kHz mono) over HTTP. The fetch
 * response body yields chunks at arbitrary byte boundaries (TCP packets).
 * Each chunk is written to the speaker stream, which for the browser path
 * becomes a separate WebSocket message. The browser interprets each message
 * as Int16Array -- if a chunk has an odd byte count, a sample is split and
 * all subsequent audio is corrupted (hiss/static).
 *
 * Run: npx tsx --test sidecar/tts-elevenlabs-hiss.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PassThrough } from "stream";

import { createElevenlabsTts } from "./tts-elevenlabs.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Sample rate of ElevenLabs PCM output */
const SAMPLE_RATE = 24000;

/** Bytes per sample (16-bit) */
const BYTES_PER_SAMPLE = 2;

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Generate a buffer of raw 16-bit signed LE PCM (440Hz sine wave).
 *
 * @param sampleCount - Number of samples to generate
 * @returns Buffer of int16 LE PCM
 */
function generateSineWavePcm(sampleCount: number): Buffer {
  const buf = Buffer.alloc(sampleCount * BYTES_PER_SAMPLE);

  for (let i = 0; i < sampleCount; i++) {
    const t = i / SAMPLE_RATE;
    const int16 = Math.round(Math.sin(2 * Math.PI * 440 * t) * 32767);
    buf.writeInt16LE(int16, i * BYTES_PER_SAMPLE);
  }

  return buf;
}

/**
 * Create a mock fetch Response whose body streams the given PCM buffer
 * split into chunks at the specified byte offsets (simulating arbitrary
 * HTTP chunked transfer boundaries).
 *
 * @param pcm - Full PCM buffer to stream
 * @param splitOffsets - Byte offsets at which to split (e.g. [1001, 2000])
 * @returns A Response object with a streaming body
 */
function createMockResponse(pcm: Buffer, splitOffsets: number[]): Response {
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const splitAt of splitOffsets) {
    if (offset >= pcm.byteLength) break;
    chunks.push(new Uint8Array(pcm.subarray(offset, Math.min(splitAt, pcm.byteLength))));
    offset = splitAt;
  }

  if (offset < pcm.byteLength) {
    chunks.push(new Uint8Array(pcm.subarray(offset)));
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, { status: 200 });
}

/**
 * Stub global fetch to return a mock response, run the callback, then restore.
 *
 * @param mockResponse - The Response to return from fetch
 * @param fn - Async function to run while fetch is stubbed
 */
async function withMockFetch(mockResponse: Response, fn: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => mockResponse;

  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ============================================================================
// TESTS
// ============================================================================

/**
 * Every write to the speaker stream must have an even byte count so the
 * browser can interpret it as Int16Array without truncating or misaligning.
 */
test("ElevenLabs chunks written to speaker must be sample-aligned (even byte count)", async () => {
  const pcm = generateSineWavePcm(2400); // 0.1s of audio = 4800 bytes
  const speakerOutput = new PassThrough();

  // Split at odd byte offsets to simulate arbitrary HTTP chunk boundaries
  const mockResponse = createMockResponse(pcm, [1001, 2000, 3333, 4001]);

  const player = await createElevenlabsTts({
    apiKey: "test-key",
    voiceId: "test-voice",
    modelId: "test-model",
    speakerInput: speakerOutput,
    interruptPlayback: () => {},
    resumePlayback: () => {},
  });

  // Collect all chunks written to the speaker stream
  const writtenChunks: Buffer[] = [];
  speakerOutput.on("data", (chunk: Buffer) => {
    writtenChunks.push(Buffer.from(chunk));
  });

  await withMockFetch(mockResponse, () => player.speak("Hello world"));

  // Every chunk written to the speaker must be sample-aligned
  const oddChunks = writtenChunks.filter((c) => c.byteLength % BYTES_PER_SAMPLE !== 0);

  assert.equal(
    oddChunks.length,
    0,
    `${oddChunks.length} of ${writtenChunks.length} chunks written to speaker had odd byte length ` +
    `(${oddChunks.map((c) => c.byteLength).join(", ")} bytes). ` +
    `Odd-length chunks split 16-bit PCM samples, causing hiss in browser playback.`
  );
});

/**
 * Sample alignment must not lose audio data. The total bytes written to the
 * speaker must equal the original PCM size.
 */
test("total bytes written to speaker must equal source PCM size", async () => {
  const pcm = generateSineWavePcm(2400); // 0.1s = 4800 bytes
  const speakerOutput = new PassThrough();

  // Odd splits that would cause byte loss if alignment just truncates
  const mockResponse = createMockResponse(pcm, [1001, 2000, 3333, 4001]);

  const player = await createElevenlabsTts({
    apiKey: "test-key",
    voiceId: "test-voice",
    modelId: "test-model",
    speakerInput: speakerOutput,
    interruptPlayback: () => {},
    resumePlayback: () => {},
  });

  const writtenChunks: Buffer[] = [];
  speakerOutput.on("data", (chunk: Buffer) => {
    writtenChunks.push(Buffer.from(chunk));
  });

  await withMockFetch(mockResponse, () => player.speak("Hello world"));

  const totalWritten = writtenChunks.reduce((sum, c) => sum + c.byteLength, 0);

  assert.equal(
    totalWritten,
    pcm.byteLength,
    `Expected ${pcm.byteLength} bytes written to speaker, got ${totalWritten}. ` +
    `Sample alignment must carry over leftover bytes, not drop them.`
  );
});
