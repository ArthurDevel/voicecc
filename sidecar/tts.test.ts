/**
 * Unit tests for TTS interrupt/resume behavior.
 *
 * Verifies that resumePlayback (SIGUSR2) is only sent after an interrupt,
 * never on normal playback. Uses a mock TTS server to avoid needing the
 * Python subprocess or audio hardware.
 *
 * Run: npx tsx --test sidecar/tts.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PassThrough } from "stream";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createTts } from "./tts.js";
import type { TtsPlayer } from "./tts.js";
import type { TtsConfig } from "./types.js";
import type { TextChunk } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, "mock-tts-server.mjs");

// ============================================================================
// HELPERS
// ============================================================================

/** Create a TtsPlayer with mocked callbacks and the mock TTS server. */
async function createTestPlayer(): Promise<{
  player: TtsPlayer;
  interruptCount: number;
  resumeCount: number;
  counts: { interrupt: number; resume: number };
}> {
  const counts = { interrupt: 0, resume: 0 };

  const config: TtsConfig = {
    model: "test",
    voice: "test",
    speakerInput: new PassThrough(),
    interruptPlayback: () => { counts.interrupt++; },
    resumePlayback: () => { counts.resume++; },
    serverCommand: ["node", MOCK_SERVER],
  };

  const player = await createTts(config);

  return { player, interruptCount: 0, resumeCount: 0, counts };
}

/** Create a simple async iterable that yields one sentence. */
async function* singleSentence(text: string): AsyncIterable<TextChunk> {
  yield text;
}

// ============================================================================
// TESTS
// ============================================================================

test("resumePlayback is NOT called on first speakStream (no prior interrupt)", async () => {
  const { player, counts } = await createTestPlayer();

  await player.speakStream(singleSentence("Hello world."));

  assert.equal(counts.resume, 0, "resumePlayback should not be called without a prior interrupt");
  assert.equal(counts.interrupt, 0, "interruptPlayback should not be called");

  player.destroy();
});

test("resumePlayback IS called on speakStream after interrupt", async () => {
  const { player, counts } = await createTestPlayer();

  // First speak -- no interrupt yet
  await player.speakStream(singleSentence("Hello."));
  assert.equal(counts.resume, 0);

  // Interrupt
  player.interrupt();
  assert.equal(counts.interrupt, 1, "interruptPlayback should be called once");

  // Next speak -- should call resumePlayback
  await player.speakStream(singleSentence("World."));
  assert.equal(counts.resume, 1, "resumePlayback should be called once after interrupt");

  player.destroy();
});

test("resumePlayback is NOT called on second speakStream after interrupt (flag resets)", async () => {
  const { player, counts } = await createTestPlayer();

  // Interrupt then speak (consumes the wasInterrupted flag)
  player.interrupt();
  await player.speakStream(singleSentence("After interrupt."));
  assert.equal(counts.resume, 1);

  // Speak again without new interrupt -- should NOT call resumePlayback
  await player.speakStream(singleSentence("No interrupt."));
  assert.equal(counts.resume, 1, "resumePlayback should still be 1 (not called again)");

  player.destroy();
});

test("resumePlayback IS called on speak() after interrupt", async () => {
  const { player, counts } = await createTestPlayer();

  player.interrupt();
  await player.speak("After interrupt.");
  assert.equal(counts.resume, 1, "resumePlayback should be called for speak() too");

  player.destroy();
});

test("multiple interrupts only trigger one resumePlayback on next speak", async () => {
  const { player, counts } = await createTestPlayer();

  player.interrupt();
  player.interrupt();
  player.interrupt();
  assert.equal(counts.interrupt, 3, "interruptPlayback called each time");

  await player.speakStream(singleSentence("After multiple interrupts."));
  assert.equal(counts.resume, 1, "resumePlayback should be called exactly once");

  player.destroy();
});
