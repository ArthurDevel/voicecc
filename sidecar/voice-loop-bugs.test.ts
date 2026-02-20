/**
 * Tests that reproduce known voice loop bugs.
 *
 * These tests FAIL with the current code and should PASS after fixes.
 *
 * Bug 1: After interrupt, stale TTS audio from the previous generation leaks
 *         into the next speakStream call (user hears previous answer).
 * Bug 2: Stale Claude SDK events from an interrupted turn leak into the next
 *         turn's sendMessage (user gets wrong response or premature end).
 *
 * Run: npx tsx --test sidecar/voice-loop-bugs.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { PassThrough } from "stream";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { createTts } from "./tts.js";
import { createClaudeSession } from "./claude-session.js";
import type { TtsConfig, TextChunk, ClaudeSessionConfig, ClaudeStreamEvent } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAGGED_MOCK_SERVER = join(__dirname, "mock-tts-server-tagged.mjs");

// ============================================================================
// HELPERS -- TTS
// ============================================================================

/**
 * Create a TtsPlayer backed by the tagged mock server.
 * The mock tags each PCM chunk with a generation counter byte (0x01, 0x02, ...)
 * and deliberately ignores interrupt commands (simulating the Python bug).
 * @returns Player, captured speaker output stream, and callback counters
 */
async function createTaggedPlayer(): Promise<{
  player: ReturnType<typeof createTts> extends Promise<infer T> ? T : never;
  speakerOutput: PassThrough;
  counts: { interrupt: number; resume: number };
}> {
  const counts = { interrupt: 0, resume: 0 };
  const speakerOutput = new PassThrough();

  const config: TtsConfig = {
    model: "test",
    voice: "test",
    speakerInput: speakerOutput,
    interruptPlayback: () => { counts.interrupt++; },
    resumePlayback: () => { counts.resume++; },
    serverCommand: ["node", TAGGED_MOCK_SERVER],
  };

  const player = await createTts(config);
  return { player, speakerOutput, counts };
}

/** Yield one sentence as a TextChunk async iterable. */
async function* singleSentence(text: string): AsyncGenerator<TextChunk> {
  yield text;
}

// ============================================================================
// HELPERS -- Mock SDK query function
// ============================================================================

/** A single SDK event to yield, with optional delay before yielding. */
interface MockStep {
  /** The SDK message object to yield */
  event: Record<string, unknown>;
  /** Delay in ms before yielding this event (default: 0) */
  delayMs?: number;
}

/** Events to yield for a single user turn. */
interface MockTurn {
  steps: MockStep[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a mock query function that replaces the real Claude SDK.
 * Consumes user messages from the prompt iterable and yields pre-configured
 * SDK events for each turn, with optional delays between events.
 * @param turns - Array of turn configurations, consumed in order
 * @returns A function matching the SDK query() signature (cast with `as any`)
 */
function createMockQueryFn(turns: MockTurn[]): (...args: unknown[]) => unknown {
  return function mockQueryFn({ prompt }: { prompt: AsyncIterable<unknown> }) {
    let turnIndex = 0;

    async function* generateEvents(): AsyncGenerator<Record<string, unknown>> {
      for await (const _userMsg of prompt) {
        const turn = turns[turnIndex++];
        if (!turn) return;

        for (const step of turn.steps) {
          if (step.delayMs) await sleep(step.delayMs);
          yield step.event;
        }
      }
    }

    const gen = generateEvents();

    // Return an async iterable with an interrupt() method (matches SDK Query interface)
    return Object.assign(gen, {
      interrupt(): void { /* no-op: mock does not support real interruption */ },
    });
  };
}

// -- SDK message factory helpers --

function makeSystemEvent(sessionId: string): Record<string, unknown> {
  return { type: "system", session_id: sessionId };
}

function makeBlockStart(index = 0): Record<string, unknown> {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
  };
}

function makeTextDelta(text: string, index = 0): Record<string, unknown> {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  };
}

function makeBlockStop(index = 0): Record<string, unknown> {
  return {
    type: "stream_event",
    event: { type: "content_block_stop", index },
  };
}

function makeAssistant(text: string): Record<string, unknown> {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  };
}

function makeResult(): Record<string, unknown> {
  return { type: "result", is_error: false, subtype: "success" };
}

// ============================================================================
// BUG 1: Stale TTS audio after interrupt
// ============================================================================

/**
 * Verifies that after interrupting TTS mid-generation, the next speakStream
 * call only plays audio from the new generation -- no leftover PCM from the
 * previous generation leaks through the subprocess stdout pipe.
 */
test("BUG: after interrupt, next speakStream plays stale audio from previous generation", { timeout: 10_000 }, async () => {
  const { player, speakerOutput } = await createTaggedPlayer();

  try {
    // Collect all PCM data written to the speaker stream
    const receivedChunks: Buffer[] = [];
    speakerOutput.on("data", (chunk: Buffer) => receivedChunks.push(Buffer.from(chunk)));

    // First generation -- mock tags all chunks with 0x01 (gen counter = 1).
    // The mock generates 15 chunks with 10ms delay each (150ms total).
    const firstStream = player.speakStream(singleSentence("First sentence."));

    // Wait for some chunks to be read by the parent, then interrupt.
    // At ~50ms, roughly 5 chunks have been generated by the mock.
    await new Promise((r) => setTimeout(r, 50));
    player.interrupt();
    await firstStream;

    // Clear captured data from first generation
    receivedChunks.length = 0;

    // Second generation -- mock tags all chunks with 0x02 (gen counter = 2).
    // BUG: readPcmChunks reads stale gen-1 chunks from the pipe before gen-2 data.
    await player.speakStream(singleSentence("Second sentence."));

    // Verify: every byte received during the second speakStream should be 0x02.
    // If any byte is 0x01, stale audio from the first generation leaked through.
    assert.ok(receivedChunks.length > 0, "Should have received audio during second speakStream");

    let staleByteCount = 0;
    let totalByteCount = 0;
    for (const chunk of receivedChunks) {
      for (let i = 0; i < chunk.length; i++) {
        totalByteCount++;
        if (chunk[i] === 0x01) staleByteCount++;
      }
    }

    assert.equal(
      staleByteCount, 0,
      `Found ${staleByteCount}/${totalByteCount} stale bytes (0x01) from first generation in second speakStream. ` +
      `The TTS pipe was not drained after interrupt, so old audio leaked into the new turn.`
    );
  } finally {
    player.destroy();
  }
});

// ============================================================================
// BUG 3: Slow drain blocks next turn when server ignores interrupt
// ============================================================================

/**
 * Verifies that after interrupt, the next speakStream starts playing new audio
 * within a bounded time -- regardless of how much audio the previous generation
 * still has left to produce. Fails when the server ignores interrupt commands
 * and the Node side must wait for the entire remaining generation to drain.
 */
test("BUG: after interrupt, next speakStream should start playing within bounded time", { timeout: 15_000 }, async () => {
  // Slow mock: 30 chunks at 100ms each = 3000ms total generation per sentence.
  // After interrupt at ~200ms (~2 chunks), remaining drain: ~2800ms.
  const counts = { interrupt: 0, resume: 0 };
  const speakerOutput = new PassThrough();

  const config: TtsConfig = {
    model: "test",
    voice: "test",
    speakerInput: speakerOutput,
    interruptPlayback: () => { counts.interrupt++; },
    resumePlayback: () => { counts.resume++; },
    serverCommand: ["node", TAGGED_MOCK_SERVER, "30", "100"],
  };

  const player = await createTts(config);

  try {
    const firstStream = player.speakStream(singleSentence("First sentence."));

    // Wait for a couple of chunks, then interrupt
    await new Promise((r) => setTimeout(r, 200));
    player.interrupt();
    await firstStream;

    // Measure time from starting second speakStream to first chunk of gen 2 (0x02).
    // The listener also fires for buffered gen-1 data, so we filter by tag.
    const t0 = Date.now();
    let firstNewChunkAt = 0;

    speakerOutput.on("data", (chunk: Buffer) => {
      if (firstNewChunkAt === 0 && chunk[0] === 0x02) {
        firstNewChunkAt = Date.now();
      }
    });

    await player.speakStream(singleSentence("Second sentence."));

    const elapsed = firstNewChunkAt - t0;
    const maxAllowedMs = 1000;

    assert.ok(
      firstNewChunkAt > 0,
      "Should have received at least one gen-2 chunk during second speakStream"
    );
    assert.ok(
      elapsed < maxAllowedMs,
      `First new chunk took ${elapsed}ms (limit: ${maxAllowedMs}ms). ` +
      `The server ignored the interrupt command, so drainStaleChunks had to wait ` +
      `for the entire remaining generation before the new turn could start.`
    );
  } finally {
    player.destroy();
  }
});

// ============================================================================
// BUG 4: Listening chime plays while TTS audio is still playing (gappy chunks)
// ============================================================================

/**
 * Verifies that speakStream waits for all audio to finish playing even when
 * chunks arrive with large gaps between them (e.g. during tool calls).
 *
 * The playback wait calculates remainingMs = totalAudioMs - (now - firstWriteAt).
 * When gaps between chunk deliveries exceed total audio duration, remainingMs
 * goes negative and the wait is skipped -- the listening chime plays while the
 * last chunk is still audible.
 */
test("BUG: speakStream resolves before audio finishes when chunks arrive with gaps", { timeout: 10_000 }, async () => {
  // Mock: 15 chunks at 1ms delay = ~15ms generation, 150ms audio per sentence.
  const counts = { interrupt: 0, resume: 0 };
  const speakerOutput = new PassThrough();

  const config: TtsConfig = {
    model: "test",
    voice: "test",
    speakerInput: speakerOutput,
    interruptPlayback: () => { counts.interrupt++; },
    resumePlayback: () => { counts.resume++; },
    serverCommand: ["node", TAGGED_MOCK_SERVER, "15", "1"],
  };

  const player = await createTts(config);

  try {
    let lastWriteTime = 0;
    speakerOutput.on("data", () => { lastWriteTime = Date.now(); });

    // Yield 3 flush-tagged sentences with 300ms gaps (simulates tool call delays).
    // totalAudioMs = 3 * 150ms = 450ms.  totalGapTime = 2 * 300ms = 600ms.
    // Since gapTime > audioTime, the wait calculation goes negative.
    async function* gappySentences(): AsyncGenerator<TextChunk> {
      yield { text: "First sentence from the tool call.", flush: true };
      await new Promise((r) => setTimeout(r, 300));
      yield { text: "Second sentence after a tool result.", flush: true };
      await new Promise((r) => setTimeout(r, 300));
      yield { text: "Third and final sentence of the response.", flush: true };
    }

    await player.speakStream(gappySentences());
    const resolveTime = Date.now();

    // The last sentence produces ~150ms of audio. speakStream should not resolve
    // until that audio has had time to play through the speaker.
    // BUG: remainingMs = 450 - ~630 = -180ms → skips wait entirely.
    const waitAfterLastWrite = resolveTime - lastWriteTime;

    assert.ok(
      waitAfterLastWrite >= 100,
      `speakStream resolved only ${waitAfterLastWrite}ms after last PCM write, ` +
      `but the last sentence has ~150ms of audio still playing. ` +
      `The playback wait calculation does not account for gaps between chunk deliveries ` +
      `(e.g. during tool calls), so remainingMs goes negative and the wait is skipped.`
    );
  } finally {
    player.destroy();
  }
});

// ============================================================================
// BUG 2: Stale Claude session events after interrupt
// ============================================================================

/**
 * Verifies that after interrupting a Claude session mid-turn, the next
 * sendMessage call only receives events from the new turn -- no stale
 * text deltas or assistant messages from the interrupted turn leak through.
 */
test("BUG: after interrupt, next sendMessage receives stale events from previous turn", { timeout: 10_000 }, async () => {
  // Mock query function with two turns:
  // Turn 1: yields text deltas, then after 50ms delay yields assistant + result.
  //   The delay simulates the SDK's async finalization that continues after interrupt.
  // Turn 2: yields text deltas + result normally.
  const mockQueryFn = createMockQueryFn([
    {
      steps: [
        { event: makeSystemEvent("test-session") },
        { event: makeBlockStart(0) },
        { event: makeTextDelta("Turn one response", 0) },
        { event: makeBlockStop(0) },
        // 50ms delay: simulates SDK finishing turn 1 asynchronously after interrupt
        { event: makeAssistant("Turn one response"), delayMs: 50 },
        { event: makeResult() },
      ],
    },
    {
      steps: [
        { event: makeBlockStart(0) },
        { event: makeTextDelta("Turn two response", 0) },
        { event: makeBlockStop(0) },
        { event: makeAssistant("Turn two response") },
        { event: makeResult() },
      ],
    },
  ]);

  const config: ClaudeSessionConfig = {
    allowedTools: [],
    permissionMode: "bypassPermissions",
    systemPrompt: "test",
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock needs type flexibility
  const session = await createClaudeSession(config, mockQueryFn as any);

  try {
    // Turn 1: read the first text_delta, then stop (simulating user interrupt)
    const turn1Events: ClaudeStreamEvent[] = [];
    for await (const event of session.sendMessage("turn 1 question")) {
      turn1Events.push(event);
      if (event.type === "text_delta") break;
    }

    assert.ok(
      turn1Events.some((e) => e.type === "text_delta" && e.content.includes("Turn one")),
      "Turn 1 should have yielded a text delta"
    );

    session.interrupt();

    // Small gap between turns (realistic: user speaks, STT runs, endpointing fires)
    await sleep(10);

    // Turn 2: read all events
    const turn2Events: ClaudeStreamEvent[] = [];
    for await (const event of session.sendMessage("turn 2 question")) {
      turn2Events.push(event);
    }

    // Assert: no stale turn-1 content leaked into turn 2
    const staleDeltas = turn2Events.filter(
      (e) => e.type === "text_delta" && e.content.includes("Turn one")
    );
    assert.equal(
      staleDeltas.length, 0,
      `Found stale turn-1 text in turn-2 events: ${JSON.stringify(staleDeltas)}. ` +
      `Events from the interrupted turn leaked through the event queue into the next turn.`
    );

    // Assert: we actually got the real turn-2 response
    const turn2Deltas = turn2Events.filter(
      (e) => e.type === "text_delta" && e.content.includes("Turn two")
    );
    assert.ok(
      turn2Deltas.length > 0,
      `Turn 2 should have yielded text deltas with 'Turn two' content, ` +
      `but got: ${JSON.stringify(turn2Events.filter((e) => e.type === "text_delta"))}`
    );
  } finally {
    await session.close();
  }
});

// ============================================================================
// BUG 5: Narration summaries queue up and burst at tool_end
// ============================================================================

/**
 * Verifies that periodic summaries from long-running tools are emitted
 * immediately as they're generated (via the timer), not queued up and
 * drained all at once when the tool ends.
 *
 * Current behavior: "Still working on Write..." messages accumulate in
 * pendingSummaries array during tool execution, then all get drained in
 * a burst when tool_end or text_delta arrives. User hears silence for
 * the entire tool duration, then multiple rapid "still working" messages.
 *
 * Expected: Each timer tick should emit exactly one summary string that
 * gets spoken immediately via TTS.
 */
test("BUG: narration summaries should emit immediately, not queue and burst at end", { timeout: 15_000 }, async () => {
  const { createNarrator } = await import("./narration.js");

  const emittedTexts: Array<{ text: string; timestamp: number }> = [];
  const startTime = Date.now();

  const narrator = createNarrator({
    summaryIntervalMs: 100, // Fire every 100ms for fast test
  }, (text: string) => {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  });

  // Simulate a long-running tool (Write tool taking 450ms)
  const toolStart: ClaudeStreamEvent = { type: "tool_start", toolName: "Write" };
  const initialTexts = narrator.processEvent(toolStart);

  for (const text of initialTexts) {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  }

  // Wait 450ms while timer fires multiple times
  await new Promise((r) => setTimeout(r, 450));

  // Tool ends
  const toolEnd: ClaudeStreamEvent = { type: "tool_end" };
  const endTexts = narrator.processEvent(toolEnd);

  for (const text of endTexts) {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  }

  // Expected: 4 summary emissions spaced ~100ms apart:
  //   t=0ms:   "Running Write..."
  //   t=100ms: "Still working on Write..."
  //   t=200ms: "Still working on Write..."
  //   t=300ms: "Still working on Write..."
  //   t=400ms: "Still working on Write..." (last one before tool_end at 450ms)
  //   t=450ms: tool_end drains any remaining (should be 0)

  const stillWorkingMessages = emittedTexts.filter(e => e.text.includes("Still working"));

  assert.ok(
    stillWorkingMessages.length >= 3,
    `Expected at least 3 "Still working" messages over 450ms with 100ms interval, got ${stillWorkingMessages.length}`
  );

  // Check if messages came in gradually (not all at once at the end)
  const timestamps = stillWorkingMessages.map(e => e.timestamp);
  const allAtEnd = timestamps.every(t => t > 400); // All after 400ms = burst at end

  assert.ok(
    !allAtEnd,
    `All ${stillWorkingMessages.length} "Still working" messages arrived after 400ms (timestamps: ${timestamps}). ` +
    `They were queued in pendingSummaries and drained in a burst at tool_end, ` +
    `instead of being emitted immediately as the timer fired.`
  );

  narrator.reset();
});
