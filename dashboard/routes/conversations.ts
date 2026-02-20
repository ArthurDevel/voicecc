/**
 * Conversation session API routes.
 *
 * Lists and reads Claude Code conversation sessions from JSONL log files:
 * - GET / -- list all sessions with summaries
 * - GET /:sessionId -- get all messages for a specific session
 */

import { Hono } from "hono";
import { readdir, stat, access } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import { createReadStream } from "fs";
import { createInterface } from "readline";

// ============================================================================
// TYPES
// ============================================================================

/** Summary of a conversation session */
interface ConversationSummary {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
}

/** A single conversation turn */
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Claude Code encodes the project path by replacing "/" with "-" */
const PROJECT_DIR_NAME = process.cwd().replace(/\//g, "-");
const SESSIONS_DIR = join(homedir(), ".claude", "projects", PROJECT_DIR_NAME);

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for conversation operations.
 *
 * @returns Hono instance with GET / (list) and GET /:sessionId (detail)
 */
export function conversationRoutes(): Hono {
  const app = new Hono();

  /** List all conversation sessions with summaries */
  app.get("/", async (c) => {
    const files = await readdir(SESSIONS_DIR);
    const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

    const summaries: ConversationSummary[] = [];

    for (const file of jsonlFiles) {
      const filePath = join(SESSIONS_DIR, file);
      const fileStat = await stat(filePath);
      const sessionId = basename(file, ".jsonl");

      const { firstUserMessage, messageCount } = await extractSessionSummary(filePath);

      summaries.push({
        sessionId,
        firstMessage: firstUserMessage,
        timestamp: fileStat.mtime.toISOString(),
        messageCount,
      });
    }

    summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return c.json(summaries);
  });

  /** Get all messages for a specific session */
  app.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

    try {
      await access(filePath);
    } catch {
      return c.json({ error: "Session not found" }, 404);
    }

    const messages = await parseSessionMessages(filePath);
    return c.json(messages);
  });

  return app;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read the first user message and count total messages in a session file.
 *
 * @param filePath - Absolute path to the JSONL file
 * @returns The first user message text and total message count
 */
async function extractSessionSummary(filePath: string): Promise<{ firstUserMessage: string; messageCount: number }> {
  let firstUserMessage = "(empty)";
  let messageCount = 0;
  let foundFirst = false;

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      messageCount++;

      if (!foundFirst && entry.type === "user") {
        const content = entry.message?.content;
        if (typeof content === "string") {
          firstUserMessage = content.slice(0, 120);
        }
        foundFirst = true;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { firstUserMessage, messageCount };
}

/**
 * Parse all user and assistant messages from a session JSONL file.
 * Deduplicates assistant messages by requestId.
 *
 * @param filePath - Absolute path to the JSONL file
 * @returns Array of ConversationMessage sorted by timestamp
 */
async function parseSessionMessages(filePath: string): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  const seenUserUuids = new Set<string>();
  const assistantTexts = new Map<string, { text: string; timestamp: string }>();

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.type === "user" && entry.message?.role === "user") {
        if (seenUserUuids.has(entry.uuid)) continue;
        seenUserUuids.add(entry.uuid);

        const content = entry.message.content;
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: "user", content, timestamp: entry.timestamp });
        }
        continue;
      }

      if (entry.type === "assistant" && entry.message?.content) {
        const requestId = entry.requestId;
        if (!requestId) continue;

        const blocks = entry.message.content;
        if (!Array.isArray(blocks)) continue;

        const textParts: string[] = [];
        for (const block of blocks) {
          if (block.type === "text" && block.text?.trim()) {
            textParts.push(block.text);
          }
        }

        if (textParts.length > 0) {
          const combined = textParts.join("");
          const existing = assistantTexts.get(requestId);
          if (!existing || combined.length > existing.text.length) {
            assistantTexts.set(requestId, { text: combined, timestamp: entry.timestamp });
          }
        }
        continue;
      }
    } catch {
      // Skip malformed lines
    }
  }

  for (const [, { text, timestamp }] of assistantTexts) {
    messages.push({ role: "assistant", content: text, timestamp });
  }

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return messages;
}
