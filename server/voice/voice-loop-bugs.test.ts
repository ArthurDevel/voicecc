/**
 * Tests that reproduce known voice loop bugs.
 *
 * Run: npx tsx --test server/voice/voice-loop-bugs.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createClaudeSession } from "./claude-session.js";
import type { TextChunk, ClaudeSessionConfig, ClaudeStreamEvent } from "./types.js";

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockQueryFn(turns: MockTurn[]): any {
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
// BUG 2: Stale Claude session events after interrupt
// ============================================================================

/**
 * Verifies that after interrupting a Claude session mid-turn, the next
 * sendMessage call only receives events from the new turn -- no stale
 * text deltas or assistant messages from the interrupted turn leak through.
 */
test("BUG: after interrupt, next sendMessage receives stale events from previous turn", { timeout: 10_000 }, async () => {
  const mockQueryFn = createMockQueryFn([
    {
      steps: [
        { event: makeSystemEvent("test-session") },
        { event: makeBlockStart(0) },
        { event: makeTextDelta("Turn one response", 0) },
        { event: makeBlockStop(0) },
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
    await sleep(10);

    const turn2Events: ClaudeStreamEvent[] = [];
    for await (const event of session.sendMessage("turn 2 question")) {
      turn2Events.push(event);
    }

    const staleDeltas = turn2Events.filter(
      (e) => e.type === "text_delta" && e.content.includes("Turn one")
    );
    assert.equal(
      staleDeltas.length, 0,
      `Found stale turn-1 text in turn-2 events: ${JSON.stringify(staleDeltas)}. ` +
      `Events from the interrupted turn leaked through the event queue into the next turn.`
    );

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
 */
test("BUG: narration summaries should emit immediately, not queue and burst at end", { timeout: 15_000 }, async () => {
  const { createNarrator } = await import("./narration.js");

  const emittedTexts: Array<{ text: string; timestamp: number }> = [];
  const startTime = Date.now();

  const narrator = createNarrator({
    summaryIntervalMs: 100,
  }, (text: string) => {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  });

  const toolStart: ClaudeStreamEvent = { type: "tool_start", toolName: "Write", content: "" };
  const initialTexts = narrator.processEvent(toolStart);

  for (const text of initialTexts) {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  }

  await new Promise((r) => setTimeout(r, 450));

  const toolEnd: ClaudeStreamEvent = { type: "tool_end", content: "" };
  const endTexts = narrator.processEvent(toolEnd);

  for (const text of endTexts) {
    emittedTexts.push({ text, timestamp: Date.now() - startTime });
  }

  const stillWorkingMessages = emittedTexts.filter(e => e.text.includes("Still working"));

  assert.ok(
    stillWorkingMessages.length >= 3,
    `Expected at least 3 "Still working" messages over 450ms with 100ms interval, got ${stillWorkingMessages.length}`
  );

  const timestamps = stillWorkingMessages.map(e => e.timestamp);
  const allAtEnd = timestamps.every(t => t > 400);

  assert.ok(
    !allAtEnd,
    `All ${stillWorkingMessages.length} "Still working" messages arrived after 400ms (timestamps: ${timestamps}). ` +
    `They were queued in pendingSummaries and drained in a burst at tool_end, ` +
    `instead of being emitted immediately as the timer fired.`
  );

  narrator.reset();
});
