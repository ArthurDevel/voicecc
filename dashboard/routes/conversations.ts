/**
 * Conversation session API routes.
 *
 * Lists and reads Claude Code conversation sessions from JSONL log files.
 * Aggregates sessions from the main project dir and all active agent dirs.
 *
 * - GET / -- list all sessions with summaries (includes agent conversations)
 * - GET /:sessionId -- get all messages for a specific session (?agentId= for agent sessions)
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
  agentId?: string;
}

/** A single conversation turn */
interface ConversationMessage {
  role: "user" | "assistant" | "tool_use" | "subagent";
  content: string;
  timestamp: string;
  /** Tool name (only for role=tool_use) */
  toolName?: string;
  /** Stringified tool input (only for role=tool_use) */
  toolInput?: string;
  /** Stringified tool result (only for role=tool_use) */
  toolResult?: string;
  /** Whether the tool call errored (only for role=tool_use) */
  toolIsError?: boolean;
  /** Subagent description (only for role=subagent) */
  subagentDescription?: string;
  /** Subagent type e.g. "Explore", "Plan" (only for role=subagent) */
  subagentType?: string;
  /** Subagent prompt (only for role=subagent) */
  subagentPrompt?: string;
  /** Subagent response text (only for role=subagent) */
  subagentResult?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Root directory where agent data is stored */
const AGENTS_DIR = join(homedir(), ".claude-voice-agents");

/** Claude Code encodes the project path by replacing "/" and "." with "-" */

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
    const sessionDirs = await collectSessionDirs();
    const summaries: ConversationSummary[] = [];

    for (const { dir, agentId } of sessionDirs) {
      const dirSummaries = await listSessionsInDir(dir, agentId);
      summaries.push(...dirSummaries);
    }

    summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return c.json(summaries);
  });

  /** Get all messages for a specific session */
  app.get("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const agentId = c.req.query("agentId");

    if (!agentId) {
      return c.json({ error: "agentId query parameter is required" }, 400);
    }

    const sessionsDir = getAgentSessionsDir(agentId);

    const filePath = join(sessionsDir, `${sessionId}.jsonl`);

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
 * Build the list of session directories to scan: main project dir + each active agent dir.
 *
 * @returns Array of { dir, agentId } where agentId is undefined for the main project
 */
async function collectSessionDirs(): Promise<Array<{ dir: string; agentId: string }>> {
  const dirs: Array<{ dir: string; agentId: string }> = [];

  let entries: string[];
  try {
    entries = await readdir(AGENTS_DIR);
  } catch {
    return dirs;
  }

  // Only include actual agent directories, skip hidden files like .DS_Store
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    dirs.push({ dir: getAgentSessionsDir(entry), agentId: entry });
  }

  return dirs;
}

/**
 * Get the Claude project sessions directory for a given agent.
 *
 * @param agentId - The agent identifier
 * @returns Absolute path to the agent's JSONL sessions directory
 */
function getAgentSessionsDir(agentId: string): string {
  const agentCwd = join(AGENTS_DIR, agentId);
  const projectDirName = agentCwd.replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", projectDirName);
}

/**
 * List all sessions in a single directory, tagging each with an optional agentId.
 *
 * @param dir - Absolute path to a Claude project sessions directory
 * @param agentId - Optional agent identifier to tag summaries with
 * @returns Array of ConversationSummary for all JSONL files in the directory
 */
async function listSessionsInDir(dir: string, agentId?: string): Promise<ConversationSummary[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
  const summaries: ConversationSummary[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(dir, file);
    const fileStat = await stat(filePath);
    const sessionId = basename(file, ".jsonl");
    const { firstUserMessage, messageCount } = await extractSessionSummary(filePath);

    summaries.push({
      sessionId,
      firstMessage: firstUserMessage,
      timestamp: fileStat.mtime.toISOString(),
      messageCount,
      ...(agentId ? { agentId } : {}),
    });
  }

  return summaries;
}

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

  /** Pending tool_use blocks waiting for their results */
  const pendingTools = new Map<string, { name: string; input: string; timestamp: string }>();
  const seenToolIds = new Set<string>();

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.type === "user" && entry.message?.role === "user") {
        if (seenUserUuids.has(entry.uuid)) continue;
        seenUserUuids.add(entry.uuid);

        const content = entry.message.content;

        // Match tool_result blocks to pending tool_use calls
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const pending = pendingTools.get(block.tool_use_id);
              if (pending) {
                const resultContent = typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content, null, 2);

                // Emit Agent tool calls as subagent role
                if (pending.name === "Agent") {
                  const parsedInput = JSON.parse(pending.input);
                  messages.push({
                    role: "subagent",
                    content: parsedInput.description || "Subagent",
                    timestamp: pending.timestamp,
                    subagentDescription: parsedInput.description,
                    subagentType: parsedInput.subagent_type,
                    subagentPrompt: parsedInput.prompt,
                    subagentResult: extractSubagentResultText(resultContent),
                  });
                } else {
                  messages.push({
                    role: "tool_use",
                    content: pending.name,
                    timestamp: pending.timestamp,
                    toolName: pending.name,
                    toolInput: pending.input,
                    toolResult: resultContent,
                    toolIsError: block.is_error === true,
                  });
                }
                pendingTools.delete(block.tool_use_id);
              }
            }
          }

          // Also extract user text from array content
          const textParts = content
            .filter((b: { type: string; text?: string }) => b.type === "text" && b.text?.trim())
            .map((b: { text: string }) => b.text);
          if (textParts.length > 0) {
            messages.push({ role: "user", content: textParts.join(""), timestamp: entry.timestamp });
          }
        } else if (typeof content === "string" && content.trim()) {
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

          // Collect tool_use blocks, keyed by their id
          if (block.type === "tool_use" && block.id && !seenToolIds.has(block.id)) {
            seenToolIds.add(block.id);
            pendingTools.set(block.id, {
              name: block.name,
              input: JSON.stringify(block.input, null, 2),
              timestamp: entry.timestamp,
            });
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

  // Add any remaining tool_use calls that never got a result
  for (const [, pending] of pendingTools) {
    if (pending.name === "Agent") {
      const parsedInput = JSON.parse(pending.input);
      messages.push({
        role: "subagent",
        content: parsedInput.description || "Subagent",
        timestamp: pending.timestamp,
        subagentDescription: parsedInput.description,
        subagentType: parsedInput.subagent_type,
        subagentPrompt: parsedInput.prompt,
      });
    } else {
      messages.push({
        role: "tool_use",
        content: pending.name,
        timestamp: pending.timestamp,
        toolName: pending.name,
        toolInput: pending.input,
      });
    }
  }

  for (const [, { text, timestamp }] of assistantTexts) {
    messages.push({ role: "assistant", content: text, timestamp });
  }

  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return messages;
}

/**
 * Extract plain text from a subagent tool result.
 * The result may be a JSON array of text blocks or a plain string.
 *
 * @param raw - Raw result content string
 * @returns Extracted text
 */
function extractSubagentResultText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((b: { type: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { text: string }) => b.text)
        .join("\n");
    }
  } catch {
    // Not JSON, return as-is
  }
  return raw;
}
