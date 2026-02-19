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
