/**
 * HTTP POST + SSE handler for text chat sessions.
 *
 * Provides a text-based chat interface to Claude using standard HTTP instead
 * of WebSocket. Messages are sent via POST and responses stream back as SSE.
 *
 * - POST /api/chat/send: sends a message, streams response as SSE
 * - POST /api/chat/close: explicitly closes a session
 * - Sessions are created on first message and persist across messages
 * - Inactivity timeout auto-cleans abandoned sessions after 10 minutes
 */

import { join } from "path";

import { createClaudeSession } from "./claude-session.js";
import { buildAgentPrompt, buildDefaultPrompt } from "./prompt-builder.js";
import { acquireSessionLock } from "./session-lock.js";
import { isValidDeviceToken } from "../services/device-pairing.js";
import { AGENTS_DIR } from "../services/agent-store.js";

import type { IncomingMessage, ServerResponse } from "http";
import type { ClaudeSession } from "./claude-session.js";
import type { SessionLock } from "./session-lock.js";
import type { ClaudeStreamEvent } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default max concurrent sessions (shared with voice sessions) */
const DEFAULT_MAX_SESSIONS = 3;

/** Inactivity timeout before auto-cleaning a session (10 minutes) */
const INACTIVITY_TIMEOUT_MS = 600_000;

/** Interval for checking inactive sessions (60 seconds) */
const CLEANUP_INTERVAL_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

/** Tracks an active text chat session */
interface ActiveChatSession {
  /** The device token used for this session */
  deviceToken: string;
  /** Claude session handle */
  claudeSession: ClaudeSession;
  /** Session lock handle */
  lock: SessionLock;
  /** Optional agent ID for agent-specific sessions */
  agentId?: string;
  /** Whether the session is currently streaming a response */
  streaming: boolean;
  /** Timestamp of last activity (used for inactivity timeout) */
  lastActivity: number;
}

/** Request body for POST /api/chat/send */
interface ChatSendBody {
  /** Device token for authentication */
  token: string;
  /** Optional agent ID for agent-specific sessions */
  agentId?: string;
  /** User message text */
  text: string;
}

/** Request body for POST /api/chat/close */
interface ChatCloseBody {
  /** Device token identifying the session to close */
  token: string;
}

/** SSE event sent to the client */
interface SseEvent {
  /** Event type */
  type: "text_delta" | "tool_start" | "tool_end" | "result" | "error";
  /** Text content or error message */
  content: string;
  /** Tool name (only for tool_start events) */
  toolName?: string;
}

// ============================================================================
// STATE
// ============================================================================

/** Active chat sessions keyed by device token */
const activeSessions = new Map<string, ActiveChatSession>();

// Start the inactivity cleanup timer
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of activeSessions) {
    if (now - session.lastActivity > INACTIVITY_TIMEOUT_MS) {
      console.log(`Chat session timed out due to inactivity, token: ${key}`);
      cleanupSession(key).catch((err) => {
        console.error(`Error cleaning up timed-out chat session: ${err}`);
      });
    }
  }
}, CLEANUP_INTERVAL_MS);

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handle an HTTP request for text chat endpoints.
 *
 * Routes POST /api/chat/send and POST /api/chat/close. Returns true if the
 * request was handled, false otherwise (so the caller can fall through to
 * other handlers).
 *
 * @param req - HTTP request
 * @param res - HTTP response
 * @returns true if handled, false otherwise
 */
export function handleChatHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "POST") return false;

  if (req.url === "/api/chat/send") {
    handleSend(req, res);
    return true;
  }

  if (req.url === "/api/chat/close") {
    handleClose(req, res);
    return true;
  }

  return false;
}

/**
 * Handle POST /api/chat/send.
 *
 * Parses the request body, validates the token, creates or reuses a session,
 * sends the message to Claude, and streams the response back as SSE.
 *
 * @param req - HTTP request with JSON body { token, agentId?, text }
 * @param res - HTTP response (SSE stream)
 */
async function handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ChatSendBody;
  try {
    body = await readJsonBody<ChatSendBody>(req);
  } catch (err) {
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return;
  }

  // Validate required fields
  if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
    sendJsonResponse(res, 400, { error: "Missing or empty 'text' field" });
    return;
  }

  if (!body.token || typeof body.token !== "string") {
    sendJsonResponse(res, 400, { error: "Missing 'token' field" });
    return;
  }

  // Validate device token (localhost bypass)
  const remoteAddr = req.socket.remoteAddress ?? "";
  const isLocalhost =
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";

  if (!isLocalhost && !isValidDeviceToken(body.token)) {
    sendJsonResponse(res, 401, { error: "Invalid device token" });
    return;
  }

  const sessionKey = body.token;
  const text = body.text.trim();

  // Get or create session
  let session: ActiveChatSession;
  try {
    session = activeSessions.get(sessionKey) ?? await createSession(sessionKey, body.agentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create session";
    console.error(`Failed to create chat session for token ${sessionKey}:`, err);
    sendJsonResponse(res, 503, { error: msg });
    return;
  }

  // Reject if already streaming
  if (session.streaming) {
    sendJsonResponse(res, 409, { error: "Already streaming a response. Wait for it to complete." });
    return;
  }

  // Update activity timestamp
  session.lastActivity = Date.now();
  session.streaming = true;

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  // Stream Claude response as SSE events
  try {
    const events: AsyncIterable<ClaudeStreamEvent> = session.claudeSession.sendMessage(text);

    for await (const event of events) {
      // Stop if client disconnected
      if (res.destroyed) break;

      const sseEvent: SseEvent = {
        type: event.type,
        content: event.content,
        ...(event.toolName && { toolName: event.toolName }),
      };

      writeSseEvent(res, sseEvent);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error during response streaming";
    console.error(`Stream error for chat token ${sessionKey}:`, err);
    writeSseEvent(res, { type: "error", content: msg });
  } finally {
    session.streaming = false;
    session.lastActivity = Date.now();
    res.end();
  }
}

/**
 * Handle POST /api/chat/close.
 *
 * Parses the request body, validates the token, and cleans up the session.
 *
 * @param req - HTTP request with JSON body { token }
 * @param res - HTTP response
 */
async function handleClose(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ChatCloseBody;
  try {
    body = await readJsonBody<ChatCloseBody>(req);
  } catch {
    sendJsonResponse(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (!body.token || typeof body.token !== "string") {
    sendJsonResponse(res, 400, { error: "Missing 'token' field" });
    return;
  }

  if (!activeSessions.has(body.token)) {
    sendJsonResponse(res, 200, { ok: true, message: "No active session" });
    return;
  }

  try {
    await cleanupSession(body.token);
    sendJsonResponse(res, 200, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to close session";
    console.error(`Error closing chat session for token ${body.token}:`, err);
    sendJsonResponse(res, 500, { error: msg });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a new chat session for the given device token.
 *
 * Acquires a session lock, builds the system prompt, creates a ClaudeSession,
 * and stores the session in the activeSessions map.
 *
 * @param sessionKey - Device token to key the session on
 * @param agentId - Optional agent ID for agent-specific prompts
 * @returns The newly created ActiveChatSession
 */
async function createSession(sessionKey: string, agentId?: string): Promise<ActiveChatSession> {
  const maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? "", 10) || DEFAULT_MAX_SESSIONS;
  const lock = acquireSessionLock(maxSessions);

  let systemPrompt: string;
  let cwd: string | undefined;

  if (agentId) {
    systemPrompt = await buildAgentPrompt(agentId, "text");
    cwd = join(AGENTS_DIR, agentId);
    console.log(`Chat session using agent "${agentId}" for token ${sessionKey}`);
  } else {
    systemPrompt = buildDefaultPrompt("text");
  }

  const claudeSession = await createClaudeSession({
    allowedTools: [],
    permissionMode: "bypassPermissions",
    systemPrompt: "",
    customSystemPrompt: systemPrompt,
    ...(cwd && { cwd }),
  });

  const session: ActiveChatSession = {
    deviceToken: sessionKey,
    claudeSession,
    lock,
    agentId,
    streaming: false,
    lastActivity: Date.now(),
  };

  activeSessions.set(sessionKey, session);
  console.log(`Chat session created, token: ${sessionKey}`);

  return session;
}

/**
 * Clean up a chat session by closing ClaudeSession, releasing the lock,
 * and removing from the activeSessions map.
 *
 * @param sessionKey - Device token identifying the session
 */
async function cleanupSession(sessionKey: string): Promise<void> {
  const session = activeSessions.get(sessionKey);
  if (!session) return;

  activeSessions.delete(sessionKey);

  await session.claudeSession.close();
  session.lock.release();

  console.log(`Chat session cleaned up, token: ${sessionKey}`);
}

/**
 * Read the full request body and parse it as JSON.
 *
 * @param req - HTTP request to read from
 * @returns Parsed JSON body
 */
function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

/**
 * Write an SSE event to the response stream.
 *
 * @param res - HTTP response to write to
 * @param event - SSE event data to serialize
 */
function writeSseEvent(res: ServerResponse, event: SseEvent): void {
  if (!res.destroyed) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
}

/**
 * Send a JSON response with the given status code and body.
 *
 * @param res - HTTP response to write to
 * @param statusCode - HTTP status code
 * @param body - JSON-serializable response body
 */
function sendJsonResponse(res: ServerResponse, statusCode: number, body: Record<string, unknown>): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
