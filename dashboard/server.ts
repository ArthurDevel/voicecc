/**
 * Dashboard HTTP server -- CLAUDE.md editor and conversation viewer.
 *
 * Serves the dashboard UI and exposes REST APIs.
 *
 * Responsibilities:
 * - Serve the editor UI from dashboard/public/
 * - Expose REST API to read and write CLAUDE.md
 * - Expose REST API to list and read conversation sessions from Claude Code JSONL logs
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, writeFile, access, readdir, stat } from "fs/promises";
import { join, extname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { execFile } from "child_process";

// ============================================================================
// CONSTANTS
// ============================================================================

const PORTS_TO_TRY = [3456, 3457, 3458, 3459, 3460];

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const CLAUDE_MD_PATH = join(process.cwd(), "CLAUDE.md");
const USER_CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");

/** Directory where Claude Code stores session JSONL files for this project.
 *  Claude Code encodes the project path by replacing "/" with "-". */
const PROJECT_DIR_NAME = process.cwd().replace(/\//g, "-");
const SESSIONS_DIR = join(homedir(), ".claude", "projects", PROJECT_DIR_NAME);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the dashboard HTTP server. Tries each port in PORTS_TO_TRY
 * until one is available.
 *
 * @returns Resolves when the server is listening
 */
export async function startDashboard(): Promise<void> {
  for (const port of PORTS_TO_TRY) {
    try {
      await listenOnPort(port);
      return;
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        console.log(`Port ${port} in use, trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All ports in use: ${PORTS_TO_TRY.join(", ")}`);
}

/**
 * Attempt to start the HTTP server on a specific port.
 *
 * @param port - Port to listen on
 * @returns Resolves when the server is listening
 */
function listenOnPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest);
    server.on("error", reject);
    server.listen(port, () => {
      console.log(`Dashboard running at http://localhost:${port}`);
      resolve();
    });
  });
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Route incoming HTTP requests to the appropriate handler.
 *
 * @param req - Incoming HTTP request
 * @param res - Server response
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      await handleStatus(res);
    } else if (pathname === "/api/claude-md" && req.method === "GET") {
      await handleRead(res);
    } else if (pathname === "/api/claude-md" && req.method === "POST") {
      await handleWrite(req, res);
    } else if (pathname === "/api/voice/start" && req.method === "POST") {
      handleStartVoice(res);
    } else if (pathname === "/api/conversations" && req.method === "GET") {
      await handleListConversations(res);
    } else if (pathname.startsWith("/api/conversations/") && req.method === "GET") {
      const sessionId = pathname.slice("/api/conversations/".length);
      await handleGetConversation(sessionId, res);
    } else {
      await handleStaticFile(pathname, res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Check for potential conflicts (e.g. user-level CLAUDE.md).
 * GET /api/status
 *
 * @param res - Server response
 */
async function handleStatus(res: ServerResponse): Promise<void> {
  const hasUserClaudeMd = await fileExists(USER_CLAUDE_MD_PATH);
  sendJson(res, 200, {
    userClaudeMdExists: hasUserClaudeMd,
    userClaudeMdPath: USER_CLAUDE_MD_PATH,
  });
}

/**
 * Read the CLAUDE.md file.
 * GET /api/claude-md
 *
 * @param res - Server response
 */
async function handleRead(res: ServerResponse): Promise<void> {
  const content = await readFile(CLAUDE_MD_PATH, "utf-8");
  sendJson(res, 200, { content });
}

/**
 * Write the CLAUDE.md file.
 * POST /api/claude-md
 * Body: { "content": "file contents" }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response
 */
async function handleWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { content } = JSON.parse(body);

  if (content === undefined) {
    sendJson(res, 400, { error: "Missing 'content' in request body" });
    return;
  }

  await writeFile(CLAUDE_MD_PATH, content, "utf-8");
  sendJson(res, 200, { success: true });
}

// ============================================================================
// VOICE HANDLER
// ============================================================================

/** The command to run in Terminal.app to start the voice sidecar */
const VOICE_CMD = `cd ${process.cwd()} && npx tsx sidecar/index.ts`;

/**
 * Open Terminal.app and start the voice sidecar process.
 * POST /api/voice/start
 *
 * @param res - Server response
 */
function handleStartVoice(res: ServerResponse): void {
  const script = `tell application "Terminal"
  activate
  do script "${VOICE_CMD}"
end tell`;

  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    sendJson(res, 200, { success: true });
  });
}

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

/** Summary of a conversation session returned by the list endpoint */
interface ConversationSummary {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
}

/** A single conversation turn (user or assistant) */
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============================================================================
// CONVERSATION HANDLERS
// ============================================================================

/**
 * List all conversation sessions with a summary.
 * GET /api/conversations
 *
 * @param res - Server response
 * @returns Array of ConversationSummary sorted by most recent first
 */
async function handleListConversations(res: ServerResponse): Promise<void> {
  const files = await readdir(SESSIONS_DIR);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const summaries: ConversationSummary[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(SESSIONS_DIR, file);
    const fileStat = await stat(filePath);
    const sessionId = basename(file, ".jsonl");

    // Read just the first few lines to extract a summary
    const { firstUserMessage, messageCount } = await extractSessionSummary(filePath);

    summaries.push({
      sessionId,
      firstMessage: firstUserMessage,
      timestamp: fileStat.mtime.toISOString(),
      messageCount,
    });
  }

  // Sort by most recent first
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  sendJson(res, 200, summaries);
}

/**
 * Get all messages for a specific conversation session.
 * GET /api/conversations/:sessionId
 *
 * @param sessionId - The UUID of the session
 * @param res - Server response
 * @returns Array of ConversationMessage for the session
 */
async function handleGetConversation(sessionId: string, res: ServerResponse): Promise<void> {
  const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

  if (!(await fileExists(filePath))) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }

  const messages = await parseSessionMessages(filePath);
  sendJson(res, 200, messages);
}

/**
 * Read the first user message and count total user/assistant messages in a session file.
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
 * Deduplicates assistant messages by requestId (the SDK emits multiple
 * partial messages with the same requestId as content blocks stream in).
 *
 * @param filePath - Absolute path to the JSONL file
 * @returns Array of ConversationMessage
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
        // Deduplicate user messages by uuid
        if (seenUserUuids.has(entry.uuid)) continue;
        seenUserUuids.add(entry.uuid);

        const content = entry.message.content;
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: "user", content, timestamp: entry.timestamp });
        }
        continue;
      }

      if (entry.type === "assistant" && entry.message?.content) {
        // Accumulate text blocks per requestId (last one wins, has most content)
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
          // Keep the longest version (last partial message has the most content)
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

  // Merge assistant messages into the timeline by inserting after the last user message
  // that precedes them chronologically
  for (const [, { text, timestamp }] of assistantTexts) {
    messages.push({ role: "assistant", content: text, timestamp });
  }

  // Sort by timestamp
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return messages;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a file exists on disk.
 *
 * @param path - Absolute file path
 * @returns True if the file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve a static file from the public directory.
 *
 * @param pathname - URL pathname (e.g. "/index.html")
 * @param res - Server response
 */
async function handleStaticFile(pathname: string, res: ServerResponse): Promise<void> {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = join(PUBLIC_DIR, filePath);

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/**
 * Read the full request body as a string.
 *
 * @param req - Incoming HTTP request
 * @returns The request body as a UTF-8 string
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param res - Server response
 * @param status - HTTP status code
 * @param data - JSON-serializable data
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
