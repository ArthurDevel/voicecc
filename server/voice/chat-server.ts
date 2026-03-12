/**
 * WebSocket handler for text chat sessions (/chat-ws endpoint).
 *
 * Provides a text-based chat interface to Claude, bypassing the entire audio
 * pipeline (no VAD, STT, TTS, endpointing, or narration). Creates a ClaudeSession
 * directly and streams events over WebSocket as JSON.
 *
 * - handleChatUpgrade: validates path, token, and accepts WebSocket upgrade
 * - handleChatSession: acquires session lock, creates ClaudeSession, listens for messages
 * - streamResponse: sends user text to Claude and streams events back as JSON
 */

import { join } from "path";

import { WebSocketServer } from "ws";

import { createClaudeSession } from "./claude-session.js";
import { buildAgentPrompt, buildDefaultPrompt } from "./prompt-builder.js";
import { acquireSessionLock } from "./session-lock.js";
import { isValidDeviceToken } from "../services/device-pairing.js";
import { AGENTS_DIR } from "../services/agent-store.js";

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { WebSocket } from "ws";
import type { ClaudeSession } from "./claude-session.js";
import type { SessionLock } from "./session-lock.js";
import type { ClaudeStreamEvent } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default max concurrent sessions (shared with voice sessions) */
const DEFAULT_MAX_SESSIONS = 3;

// ============================================================================
// TYPES
// ============================================================================

/** Tracks an active text chat session */
interface ActiveChatSession {
  /** The device token used for this session */
  deviceToken: string;
  /** Claude session handle (null until created) */
  claudeSession: ClaudeSession | null;
  /** Optional agent ID for agent-specific sessions */
  agentId?: string;
  /** Whether the session is currently streaming a response */
  streaming: boolean;
}

/** Incoming message from the chat WebSocket client */
interface ChatWsMessage {
  /** Message type -- only "user_message" is supported */
  type: "user_message";
  /** The user's message text */
  text: string;
}

/** Outgoing message sent to the chat WebSocket client */
interface ChatWsOutgoing {
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

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handle a WebSocket upgrade request for text chat.
 *
 * Validates that the path is /chat-ws, extracts the device token and agentId
 * from query params, checks authorization (localhost or valid device token),
 * and rejects duplicate connections for the same device token.
 *
 * @param req - HTTP upgrade request
 * @param socket - Underlying TCP socket
 * @param head - First packet of the upgraded stream
 * @param wss - WebSocketServer instance to accept the upgrade
 */
export function handleChatUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): void {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);

  // Validate path
  if (url.pathname !== "/chat-ws") {
    console.log(`Rejected chat WebSocket upgrade: invalid path ${url.pathname}`);
    socket.destroy();
    return;
  }

  // Extract device token from query string
  const token = url.searchParams.get("token") ?? "";

  // Check authorization: localhost bypasses token validation
  const remoteAddr = req.socket.remoteAddress ?? "";
  const isLocalhost =
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";

  if (!isLocalhost && !token) {
    console.log("Rejected chat WebSocket upgrade: missing device token");
    socket.destroy();
    return;
  }

  if (!isLocalhost && !isValidDeviceToken(token)) {
    console.log("Rejected chat WebSocket upgrade: invalid device token");
    socket.destroy();
    return;
  }

  // Reject duplicate connections for the same device token
  const sessionKey = token || "localhost-chat";
  if (activeSessions.has(sessionKey)) {
    console.log(`Rejected chat WebSocket upgrade: duplicate device token ${sessionKey}`);
    socket.destroy();
    return;
  }

  // Extract optional agentId from query params
  const agentId = url.searchParams.get("agentId") || undefined;

  // Accept the WebSocket connection
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
    handleChatSession(ws, sessionKey, agentId);
  });
}

// ============================================================================
// SESSION HANDLER
// ============================================================================

/**
 * Handle a connected text chat WebSocket session.
 *
 * Acquires a session lock, creates a ClaudeSession with the appropriate
 * system prompt (agent-specific or default, with text overlay), and listens
 * for user messages. Streams Claude responses back as JSON events.
 *
 * @param ws - Connected WebSocket for text chat
 * @param deviceToken - Device token identifying this connection
 * @param agentId - Optional agent ID for agent-specific sessions
 */
async function handleChatSession(ws: WebSocket, deviceToken: string, agentId?: string): Promise<void> {
  let cleaned = false;
  let lock: SessionLock | null = null;

  // Register in active sessions immediately to prevent duplicates
  const entry: ActiveChatSession = { deviceToken, claudeSession: null, agentId, streaming: false };
  activeSessions.set(deviceToken, entry);

  console.log(`Chat session connected, token: ${deviceToken}`);

  /**
   * Clean up the chat session. Closes ClaudeSession, releases session lock,
   * and removes from activeSessions. Uses cleaned flag to prevent double-cleanup.
   */
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    if (entry.claudeSession) {
      await entry.claudeSession.close();
    }

    if (lock) {
      lock.release();
    }

    activeSessions.delete(deviceToken);
    console.log(`Chat session cleaned up, token: ${deviceToken}`);
  }

  // Register close/error handlers
  ws.on("close", () => {
    cleanup().catch((err) => {
      console.error(`Error during chat session cleanup: ${err}`);
    });
  });

  ws.on("error", (err) => {
    console.error(`Chat WebSocket error for token ${deviceToken}: ${err}`);
  });

  // Acquire session lock (throws if limit reached)
  try {
    const maxSessions = parseInt(process.env.MAX_CONCURRENT_SESSIONS ?? "", 10) || DEFAULT_MAX_SESSIONS;
    lock = acquireSessionLock(maxSessions);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Session limit reached";
    sendJson(ws, { type: "error", content: msg });
    ws.close();
    return;
  }

  // Build system prompt based on whether we have an agent
  try {
    let systemPrompt: string;
    let cwd: string | undefined;

    if (agentId) {
      systemPrompt = await buildAgentPrompt(agentId, "text");
      cwd = join(AGENTS_DIR, agentId);
      console.log(`Chat session using agent "${agentId}" for token ${deviceToken}`);
    } else {
      systemPrompt = buildDefaultPrompt("text");
    }

    // Create Claude session
    entry.claudeSession = await createClaudeSession({
      allowedTools: [],
      permissionMode: "bypassPermissions",
      systemPrompt: "",
      customSystemPrompt: systemPrompt,
      ...(cwd && { cwd }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create Claude session";
    console.error(`Failed to create Claude session for chat token ${deviceToken}:`, err);
    sendJson(ws, { type: "error", content: msg });
    ws.close();
    return;
  }

  // Listen for user messages
  ws.on("message", (data) => {
    handleUserMessage(ws, entry, data).catch((err) => {
      console.error(`Error handling chat message for token ${deviceToken}:`, err);
      sendJson(ws, { type: "error", content: "Internal error processing message" });
    });
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse and handle an incoming user message from the WebSocket.
 *
 * Validates the message format, checks the streaming flag to prevent
 * concurrent messages, and delegates to streamResponse.
 *
 * @param ws - Connected WebSocket
 * @param entry - Active chat session entry
 * @param data - Raw WebSocket message data
 */
async function handleUserMessage(ws: WebSocket, entry: ActiveChatSession, data: unknown): Promise<void> {
  // Prevent concurrent messages while streaming
  if (entry.streaming) {
    sendJson(ws, { type: "error", content: "Please wait for the current response to complete" });
    return;
  }

  // Parse message
  let parsed: ChatWsMessage;
  try {
    const raw = typeof data === "string" ? data : String(data);
    parsed = JSON.parse(raw) as ChatWsMessage;
  } catch {
    sendJson(ws, { type: "error", content: "Invalid JSON message" });
    return;
  }

  // Validate message type
  if (parsed.type !== "user_message" || typeof parsed.text !== "string") {
    sendJson(ws, { type: "error", content: "Invalid message format. Expected { type: \"user_message\", text: \"...\" }" });
    return;
  }

  const text = parsed.text.trim();
  if (!text) {
    sendJson(ws, { type: "error", content: "Cannot send empty message" });
    return;
  }

  if (!entry.claudeSession) {
    sendJson(ws, { type: "error", content: "Claude session not initialized" });
    return;
  }

  await streamResponse(ws, entry, text);
}

/**
 * Send user text to Claude and stream response events back over WebSocket.
 *
 * Iterates the async generator from ClaudeSession.sendMessage and forwards
 * each ClaudeStreamEvent as a JSON message to the client.
 *
 * @param ws - Connected WebSocket
 * @param entry - Active chat session entry (used for streaming flag)
 * @param text - User message text to send to Claude
 */
async function streamResponse(ws: WebSocket, entry: ActiveChatSession, text: string): Promise<void> {
  entry.streaming = true;

  try {
    const events: AsyncIterable<ClaudeStreamEvent> = entry.claudeSession!.sendMessage(text);

    for await (const event of events) {
      // Skip sending if WebSocket is no longer open
      if (ws.readyState !== ws.OPEN) break;

      const outgoing: ChatWsOutgoing = {
        type: event.type,
        content: event.content,
        ...(event.toolName && { toolName: event.toolName }),
      };

      sendJson(ws, outgoing);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error during response streaming";
    console.error(`Stream error for chat token ${entry.deviceToken}:`, err);
    sendJson(ws, { type: "error", content: msg });
  } finally {
    entry.streaming = false;
  }
}

/**
 * Send a JSON object over a WebSocket connection.
 *
 * @param ws - WebSocket to send on
 * @param data - Object to serialize and send
 */
function sendJson(ws: WebSocket, data: ChatWsOutgoing): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data));
  }
}
