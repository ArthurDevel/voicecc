/**
 * Core session management for text chat sessions.
 *
 * Manages ClaudeSession lifecycle for text chat: creation on first message,
 * reuse across messages, and cleanup on close or inactivity timeout.
 * Framework-agnostic -- the Hono route layer in dashboard/routes/chat.ts
 * calls these functions.
 *
 * - getOrCreateSession: lazily creates a session on first message
 * - streamMessage: sends user text to Claude, yields SSE events
 * - closeSession: cleans up a session
 * - Inactivity timeout auto-cleans abandoned sessions after 10 minutes
 */

import { join } from "path";

import { createClaudeSession } from "./claude-session.js";
import { buildAgentPrompt, buildDefaultPrompt } from "./prompt-builder.js";
import { acquireSessionLock } from "./session-lock.js";
import { AGENTS_DIR } from "../services/agent-store.js";

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

/** SSE event sent to the client */
export interface ChatSseEvent {
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
      closeSession(key).catch((err) => {
        console.error(`Error cleaning up timed-out chat session: ${err}`);
      });
    }
  }
}, CLEANUP_INTERVAL_MS);

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Get or create a chat session for the given token.
 *
 * On first call for a token, acquires a session lock, builds the system
 * prompt, and creates a ClaudeSession. Subsequent calls return the existing
 * session.
 *
 * @param sessionKey - Device token to key the session on
 * @param agentId - Optional agent ID for agent-specific prompts
 * @returns The active chat session
 */
export async function getOrCreateSession(sessionKey: string, agentId?: string): Promise<ActiveChatSession> {
  const existing = activeSessions.get(sessionKey);
  if (existing) return existing;

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
 * Send a user message and yield SSE events from Claude's response.
 *
 * Sets the streaming flag to prevent concurrent messages. Yields each
 * ClaudeStreamEvent as a ChatSseEvent. Throws if the session is already
 * streaming.
 *
 * @param sessionKey - Device token identifying the session
 * @param text - User message text
 * @yields ChatSseEvent objects for each streaming event
 */
export async function* streamMessage(sessionKey: string, text: string): AsyncGenerator<ChatSseEvent> {
  const session = activeSessions.get(sessionKey);
  if (!session) throw new Error("No active session");

  if (session.streaming) {
    throw new Error("ALREADY_STREAMING");
  }

  session.lastActivity = Date.now();
  session.streaming = true;

  try {
    const events: AsyncIterable<ClaudeStreamEvent> = session.claudeSession.sendMessage(text);

    for await (const event of events) {
      const sseEvent: ChatSseEvent = {
        type: event.type,
        content: event.content,
        ...(event.toolName && { toolName: event.toolName }),
      };

      yield sseEvent;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error during response streaming";
    console.error(`Stream error for chat token ${sessionKey}:`, err);
    yield { type: "error", content: msg };
  } finally {
    session.streaming = false;
    session.lastActivity = Date.now();
  }
}

/**
 * Close a chat session by closing ClaudeSession, releasing the lock,
 * and removing from the activeSessions map.
 *
 * @param sessionKey - Device token identifying the session
 */
export async function closeSession(sessionKey: string): Promise<void> {
  const session = activeSessions.get(sessionKey);
  if (!session) return;

  activeSessions.delete(sessionKey);

  await session.claudeSession.close();
  session.lock.release();

  console.log(`Chat session cleaned up, token: ${sessionKey}`);
}

/**
 * Interrupt the current streaming response for a session.
 *
 * Calls interrupt() on the underlying ClaudeSession to stop generation,
 * and resets the streaming flag so the user can send a new message.
 *
 * @param sessionKey - Device token identifying the session
 * @returns true if a streaming session was interrupted, false if nothing to interrupt
 */
export function interruptSession(sessionKey: string): boolean {
  const session = activeSessions.get(sessionKey);
  if (!session || !session.streaming) return false;

  session.claudeSession.interrupt();
  session.streaming = false;
  session.lastActivity = Date.now();

  console.log(`Chat session interrupted, token: ${sessionKey}`);
  return true;
}

/**
 * Check if a session exists for the given token.
 *
 * @param sessionKey - Device token to check
 * @returns true if a session exists
 */
export function hasSession(sessionKey: string): boolean {
  return activeSessions.has(sessionKey);
}
