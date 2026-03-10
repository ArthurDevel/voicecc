/**
 * Test: SDK event timing for extended thinking.
 *
 * Sends a prompt that triggers extended thinking and logs every SDK event
 * with a timestamp to a log file.
 *
 * Usage:
 *   node testscripts/2026.03.10-thinking-timing/test-sdk-event-timing.mjs
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, appendFileSync } from "fs";

// Avoid "nested session" detection when running inside Claude Code
delete process.env.CLAUDECODE;

const LOGFILE = "testscripts/2026.03.10-thinking-timing/timing.log";
const t0 = Date.now();

writeFileSync(LOGFILE, "");

function log(msg) {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${msg}\n`;
  appendFileSync(LOGFILE, line);
}

async function* userMessages() {
  yield {
    type: "user",
    message: {
      role: "user",
      content: "What are three non-obvious consequences of the invention of the printing press? Think step by step.",
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

log("starting query");

let q;
try {
  q = query({
    prompt: userMessages(),
    options: {
      maxThinkingTokens: 10000,
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Keep answers brief (2-3 sentences each).",
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
      cwd: process.cwd(),
    },
  });
  log("query created OK");
} catch (err) {
  log(`query() threw: ${err.message}`);
  process.exit(1);
}

setTimeout(() => {
  log("HARD TIMEOUT 60s");
  process.exit(1);
}, 60_000);

let thinkingStartedAt = null;
let thinkingEndedAt = null;
let firstTextDeltaAt = null;

try {
  for await (const msg of q) {
    if (msg.type === "system") {
      log(`system: session_id=${msg.session_id}`);
      continue;
    }

    if (msg.type === "stream_event") {
      const event = msg.event;

      if (event.type === "message_start") {
        log(`stream: message_start model=${event.message?.model}`);
        continue;
      }

      if (event.type === "content_block_start") {
        const blockType = event.content_block?.type;
        log(`stream: content_block_start index=${event.index} type=${blockType}`);
        if (blockType === "thinking") {
          thinkingStartedAt = Date.now() - t0;
        }
        continue;
      }

      if (event.type === "content_block_delta") {
        const deltaType = event.delta?.type;
        if (deltaType === "thinking_delta") {
          if (!thinkingStartedAt) {
            log("stream: first thinking_delta (no block_start seen!)");
            thinkingStartedAt = Date.now() - t0;
          }
        } else if (deltaType === "text_delta") {
          if (!firstTextDeltaAt) {
            firstTextDeltaAt = Date.now() - t0;
            log(`stream: first text_delta "${event.delta.text.slice(0, 50)}"`);
          }
        } else {
          log(`stream: content_block_delta type=${deltaType}`);
        }
        continue;
      }

      if (event.type === "content_block_stop") {
        log(`stream: content_block_stop index=${event.index}`);
        if (thinkingStartedAt && !thinkingEndedAt) {
          thinkingEndedAt = Date.now() - t0;
        }
        continue;
      }

      if (event.type === "message_delta") {
        log(`stream: message_delta stop_reason=${event.delta?.stop_reason}`);
        continue;
      }

      if (event.type === "message_stop") {
        log("stream: message_stop");
        continue;
      }

      log(`stream: ${event.type}`);
      continue;
    }

    if (msg.type === "assistant") {
      const blockTypes = msg.message?.content?.map(b => b.type).join(", ") || "?";
      log(`assistant: blocks=[${blockTypes}]`);
      continue;
    }

    if (msg.type === "result") {
      log(`result: is_error=${msg.is_error}`);
      continue;
    }

    log(`event: ${msg.type}`);
  }
} catch (err) {
  log(`iteration error: ${err.message}`);
}

log("");
log("=== TIMING SUMMARY ===");
log(`Thinking content_block_start: ${thinkingStartedAt != null ? thinkingStartedAt + "ms" : "NEVER RECEIVED"}`);
log(`Thinking content_block_stop:  ${thinkingEndedAt != null ? thinkingEndedAt + "ms" : "NEVER RECEIVED"}`);
log(`First text_delta:             ${firstTextDeltaAt != null ? firstTextDeltaAt + "ms" : "NEVER RECEIVED"}`);

if (thinkingStartedAt != null && thinkingEndedAt != null) {
  const thinkingDuration = thinkingEndedAt - thinkingStartedAt;
  log(`Thinking duration:            ${thinkingDuration}ms`);
  if (thinkingEndedAt - thinkingStartedAt < 100) {
    log(">> BUFFERED: thinking start+stop arrived together");
  } else {
    log(">> STREAMING: thinking events streamed in real time");
  }
}

process.exit(0);
