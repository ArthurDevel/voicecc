/**
 * Claude session via the `claude` CLI with streaming JSON output.
 *
 * Spawns the globally installed `claude` binary in print mode with
 * `--output-format stream-json` to get streaming text deltas. Uses the
 * user's existing Claude Code subscription auth (no API key needed).
 *
 * Responsibilities:
 * - Spawn `claude` CLI per turn with --resume for conversation continuity
 * - Parse streaming JSON lines into ClaudeStreamEvent objects
 * - Support interruption by killing the child process
 * - Provide clean session teardown
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface } from "readline";
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
  let currentProcess: ChildProcess | null = null;
  let closed = false;

  return {
    async *sendMessage(text: string): AsyncIterable<ClaudeStreamEvent> {
      if (closed) {
        throw new Error("Session is closed.");
      }

      if (!text.trim()) {
        throw new Error("Cannot send empty message.");
      }

      const args = [
        "--print",
        "--verbose",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--system-prompt", systemPrompt,
        "--max-turns", String(config.maxTurns),
        "--dangerously-skip-permissions",
      ];

      // Resume the same session for multi-turn context
      if (sessionId) {
        args.push("--resume", sessionId);
      }

      args.push("--", text);

      const child = spawn(CLAUDE_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      currentProcess = child;

      const rl = createInterface({ input: child.stdout! });
      let hasError = false;
      let hasStreamedText = false;

      // Log stderr for debugging
      child.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) {
          console.error(`[claude-stderr] ${msg}`);
        }
      });

      for await (const line of rl) {
        if (!line.trim()) continue;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        // Capture session ID for resume on subsequent turns
        if (parsed.session_id && !sessionId) {
          sessionId = parsed.session_id as string;
        }

        // Result message -- turn complete
        if (parsed.type === "result") {
          if (parsed.is_error) {
            hasError = true;
            yield { type: "error", content: String(parsed.result || "Unknown error") };
          }
          break;
        }

        // Streaming content_block_delta with text (from --include-partial-messages)
        if (parsed.type === "content_block_delta") {
          const delta = parsed.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            hasStreamedText = true;
            yield { type: "text_delta", content: delta.text };
          }
          continue;
        }

        // Assistant message with full content blocks (non-streaming fallback).
        // Skip if we already yielded streaming deltas to avoid double-speaking.
        if (parsed.type === "assistant" && parsed.message) {
          if (hasStreamedText) continue;
          const msg = parsed.message as Record<string, unknown>;
          const blocks = msg.content as Array<Record<string, unknown>> | undefined;
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string") {
                yield { type: "text_delta", content: block.text };
              }
            }
          }
          continue;
        }
      }

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
        } else {
          child.on("close", () => resolve());
        }
      });

      currentProcess = null;

      if (!hasError) {
        yield { type: "result", content: "" };
      }
    },

    interrupt(): void {
      if (currentProcess) {
        currentProcess.kill("SIGTERM");
        currentProcess = null;
      }
    },

    async close(): Promise<void> {
      if (currentProcess) {
        currentProcess.kill("SIGTERM");
        currentProcess = null;
      }
      closed = true;
    },
  };
}

export { createClaudeSession };
export type { ClaudeSession };
