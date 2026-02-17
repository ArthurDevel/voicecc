/**
 * Claude session via the @anthropic-ai/claude-code SDK.
 *
 * Uses the SDK's `query()` function with `includePartialMessages: true` for
 * true token-level streaming. Runs against the user's existing Claude Code
 * subscription (no API key needed). Supports multi-turn via `resume`.
 *
 * Responsibilities:
 * - Call SDK query() per turn with resume for conversation continuity
 * - Extract streaming text deltas from SDKPartialAssistantMessage events
 * - Map tool_use content blocks to tool_start / tool_end events
 * - Support interruption via query.interrupt()
 * - Provide clean session teardown
 */

import { query as claudeQuery, type Query, type Options } from "@anthropic-ai/claude-code";
import type { ClaudeSessionConfig, ClaudeStreamEvent } from "./types.js";

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
  let sessionId: string | null = null;
  let currentQuery: Query | null = null;
  let closed = false;

  return {
    async *sendMessage(text: string): AsyncIterable<ClaudeStreamEvent> {
      if (closed) {
        throw new Error("Session is closed.");
      }

      if (!text.trim()) {
        throw new Error("Cannot send empty message.");
      }

      const t0 = Date.now();
      let hasStreamedText = false;

      const options: Options = {
        pathToClaudeCodeExecutable: CLAUDE_BIN,
        includePartialMessages: true,
        appendSystemPrompt: systemPrompt,
        maxTurns: config.maxTurns,
        permissionMode: config.permissionMode as Options["permissionMode"],
        stderr: (data: string) => {
          const msg = data.trim();
          if (msg) console.error(`[claude-stderr] ${msg}`);
        },
      };

      if (sessionId) {
        options.resume = sessionId;
      }

      const q = claudeQuery({ prompt: text, options });
      currentQuery = q;

      // Track which content block indices are tool_use blocks
      const toolUseBlocks = new Set<number>();

      try {
        for await (const msg of q) {
          // Log all message types for debugging
          const debugType = msg.type === "stream_event" ? `stream_event/${(msg as any).event?.type}` : msg.type;
          if (msg.type !== "stream_event") {
            console.log(`[claude] event: ${debugType}`);
          }
          // Capture session ID for resume on subsequent turns
          if (msg.session_id && !sessionId) {
            sessionId = msg.session_id;
          }

          // Streaming events (token-level deltas from includePartialMessages)
          if (msg.type === "stream_event") {
            const event = msg.event;

            if (event.type === "content_block_start") {
              if (event.content_block.type === "tool_use") {
                toolUseBlocks.add(event.index);
                yield { type: "tool_start", content: "", toolName: event.content_block.name };
              }
              continue;
            }

            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                if (!hasStreamedText) {
                  console.log(`[claude] first delta at +${Date.now() - t0}ms`);
                }
                hasStreamedText = true;
                yield { type: "text_delta", content: event.delta.text };
              }
              continue;
            }

            if (event.type === "content_block_stop") {
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
            if (hasStreamedText) {
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
            // Reset tool tracking for next turn (tool results may produce more streaming)
            toolUseBlocks.clear();
            continue;
          }

          // Result — turn complete
          if (msg.type === "result") {
            console.log(`[claude] result at +${Date.now() - t0}ms (streamed=${hasStreamedText})`);
            if (msg.is_error) {
              yield { type: "error", content: msg.subtype === "success" ? String((msg as any).result) : msg.subtype };
            }
            break;
          }
        }
      } catch (err) {
        console.error(`[claude] SDK error:`, err);
        yield { type: "error", content: String(err) };
      } finally {
        currentQuery = null;
      }

      yield { type: "result", content: "" };
    },

    interrupt(): void {
      if (currentQuery) {
        currentQuery.interrupt();
        currentQuery = null;
      }
    },

    async close(): Promise<void> {
      if (currentQuery) {
        await currentQuery.interrupt();
        currentQuery = null;
      }
      closed = true;
    },
  };
}

export { createClaudeSession };
export type { ClaudeSession };
