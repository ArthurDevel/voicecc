/**
 * Claude session via the @anthropic-ai/claude-code SDK.
 *
 * Keeps a single persistent Claude Code process alive across turns using
 * streaming I/O (AsyncIterable<SDKUserMessage> input). This eliminates the
 * ~2-3s process spawn overhead on each turn.
 *
 * Responsibilities:
 * - Start a persistent query() on createClaudeSession (process spawns once)
 * - Push user messages into the live session via an async queue
 * - Extract streaming text deltas from SDKPartialAssistantMessage events
 * - Map tool_use content blocks to tool_start / tool_end events
 * - Support interruption via query.interrupt()
 * - Provide clean session teardown
 */

import { query as claudeQuery, type Query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-code";
import type { ClaudeSessionConfig, ClaudeStreamEvent } from "./types.js";

// ============================================================================
// ASYNC QUEUE
// ============================================================================

/** Simple async iterable backed by a push queue. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private resolve: ((r: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T) {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
  }

  close() {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  /** Read one item (used by sendMessage to drain the event channel). */
  async next(): Promise<T | undefined> {
    if (this.buf.length > 0) return this.buf.shift()!;
    if (this.done) return undefined;
    const result = await new Promise<IteratorResult<T>>((r) => { this.resolve = r; });
    return result.done ? undefined : result.value;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length > 0) {
          return Promise.resolve({ value: this.buf.shift()!, done: false as const });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true as const });
        }
        return new Promise<IteratorResult<T>>((r) => { this.resolve = r; });
      },
    };
  }
}

// ============================================================================
// INTERFACES
// ============================================================================

/** Session object returned by createClaudeSession. */
interface ClaudeSession {
  sendMessage(text: string): AsyncIterable<ClaudeStreamEvent>;
  interrupt(): void;
  close(): Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = "/Users/Focus/.local/bin/claude";

const DEFAULT_SYSTEM_PROMPT =
  "Respond concisely. You are in voice mode -- your responses will be spoken aloud. Keep answers conversational and brief.";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

async function createClaudeSession(
  config: ClaudeSessionConfig,
): Promise<ClaudeSession> {
  const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  let sessionId = "";
  let closed = false;

  // Persistent input stream — user messages are pushed here across turns
  const userMessages = new AsyncQueue<SDKUserMessage>();

  // Event channel — SDK events are routed here for sendMessage to consume
  const sdkEvents = new AsyncQueue<SDKMessage>();

  const options: Options = {
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    includePartialMessages: true,
    maxThinkingTokens: 10000,
    appendSystemPrompt: systemPrompt,
    permissionMode: config.permissionMode as Options["permissionMode"],
    stderr: (data: string) => {
      const msg = data.trim();
      if (msg) console.error(`[claude-stderr] ${msg}`);
    },
  };

  // Start persistent query — process spawns once and stays alive.
  // NOTE: with AsyncIterable<SDKUserMessage> input, the SDK won't yield
  // events until the first user message is consumed, so we don't block
  // waiting for a system init event here. Session ID is captured when
  // the system event arrives during the first turn.
  const q = claudeQuery({ prompt: userMessages, options });

  // Background: pump SDK events into our channel
  (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === "system" && !sessionId) {
          sessionId = msg.session_id;
          console.log(`[claude] session ready (id=${sessionId})`);
        }
        sdkEvents.push(msg);
      }
    } catch (err) {
      console.error("[claude] SDK pump error:", err);
    } finally {
      sdkEvents.close();
    }
  })();

  console.log("[claude] persistent process started");

  return {
    async *sendMessage(text: string): AsyncIterable<ClaudeStreamEvent> {
      if (closed) {
        throw new Error("Session is closed.");
      }

      if (!text.trim()) {
        throw new Error("Cannot send empty message.");
      }

      const t0 = Date.now();
      let hasStreamedContent = false;
      const toolUseBlocks = new Set<number>();
      const thinkingBlocks = new Set<number>();

      // Push user message into the live session
      userMessages.push({
        type: "user",
        message: { content: text, role: "user" },
        parent_tool_use_id: null,
        session_id: sessionId,
      });

      // Read events for this turn until result
      while (true) {
        const msg = await sdkEvents.next();
        if (!msg) break; // channel closed (process died)

        // Streaming events (token-level deltas)
        if (msg.type === "stream_event") {
          const event = msg.event;

          if (event.type === "content_block_start") {
            if (event.content_block.type === "tool_use") {
              hasStreamedContent = true;
              toolUseBlocks.add(event.index);
              yield { type: "tool_start", content: "", toolName: event.content_block.name };
            }
            if (event.content_block.type === "thinking") {
              hasStreamedContent = true;
              thinkingBlocks.add(event.index);
              console.log(`[claude] thinking started at +${Date.now() - t0}ms`);
              yield { type: "text_delta", content: "Thinking... " };
            }
            continue;
          }

          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              if (!hasStreamedContent) {
                console.log(`[claude] first delta at +${Date.now() - t0}ms`);
              }
              hasStreamedContent = true;
              yield { type: "text_delta", content: event.delta.text };
            }
            continue;
          }

          if (event.type === "content_block_stop") {
            if (thinkingBlocks.has(event.index)) {
              thinkingBlocks.delete(event.index);
              console.log(`[claude] thinking ended at +${Date.now() - t0}ms`);
            }
            if (toolUseBlocks.has(event.index)) {
              toolUseBlocks.delete(event.index);
              yield { type: "tool_end", content: "" };
            }
            continue;
          }

          continue;
        }

        // Full assistant message — fallback if streaming didn't produce deltas
        if (msg.type === "assistant") {
          if (hasStreamedContent) {
            console.log(`[claude] full message at +${Date.now() - t0}ms (skipped, already streamed)`);
          } else {
            console.log(`[claude] full message at +${Date.now() - t0}ms (no streaming, using fallback)`);
            const blocks = msg.message.content;
            if (Array.isArray(blocks)) {
              for (const block of blocks) {
                if (block.type === "text") {
                  yield { type: "text_delta", content: block.text };
                }
                if (block.type === "tool_use") {
                  yield { type: "tool_start", content: "", toolName: block.name };
                }
              }
            }
          }
          toolUseBlocks.clear();
          continue;
        }

        // Skip system events and synthetic user messages (tool results)
        if (msg.type === "system" || msg.type === "user") {
          continue;
        }

        // Result — turn complete
        if (msg.type === "result") {
          console.log(`[claude] result at +${Date.now() - t0}ms (streamed=${hasStreamedContent})`);
          if (msg.is_error) {
            yield { type: "error", content: msg.subtype === "success" ? String((msg as any).result) : msg.subtype };
          }
          break;
        }
      }

      yield { type: "result", content: "" };
    },

    interrupt(): void {
      q.interrupt();
    },

    async close(): Promise<void> {
      closed = true;
      userMessages.close();
      await q.interrupt();
    },
  };
}

export { createClaudeSession };
export type { ClaudeSession };
