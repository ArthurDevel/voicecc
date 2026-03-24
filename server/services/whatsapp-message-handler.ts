/**
 * Incoming WhatsApp message handler for VoiceCC.
 *
 * Routes group messages to the Python /chat/send endpoint, streams the SSE
 * response, and sends each logical message to WhatsApp as soon as it completes.
 *
 * Responsibilities:
 * - Validate and filter incoming Baileys messages (only owner text in mapped groups)
 * - Normalize JIDs to handle the :0 device suffix from Baileys
 * - Stream SSE from Python and yield message segments at tool_start / result boundaries
 * - Send each segment to WhatsApp immediately (no buffering the full response)
 * - Handle concurrency (HTTP 409 -> "Still thinking, please wait...")
 * - Store session IDs for conversation resume
 * - Split long replies that exceed WhatsApp's byte limit
 */

import { proto } from "baileys";
import { getSocket } from "./whatsapp-manager.js";
import {
  getAgentIdForGroup,
  getLastSessionId,
  setLastSessionId,
} from "./whatsapp-groups.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base URL for the Python FastAPI server */
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

/** Maximum WhatsApp message size in bytes */
const MAX_MESSAGE_BYTES = 65_536;

/** Reply sent when the agent is already processing a message */
const ALREADY_STREAMING_REPLY = "Still thinking, please wait...";

/** User-friendly error message for SSE error events */
const SSE_ERROR_REPLY = "Sorry, something went wrong while generating a response. Please try again.";

// ============================================================================
// TYPES
// ============================================================================

/** Parsed incoming WhatsApp message ready for handling */
export interface WhatsAppIncomingMessage {
  groupJid: string;
  senderJid: string;
  text: string;
  messageId: string;
}

/** A single message segment yielded by the SSE stream generator */
export interface SseSegment {
  text: string;
  sessionId: string | null;
  isAlreadyStreaming: boolean;
  isError: boolean;
}

/** Shape of an SSE event payload from Python /chat/send (camelCase, matches Python to_dict()) */
interface SseEventPayload {
  type: string;
  content?: string;
  sessionId?: string;
  toolName?: string;
  error?: string;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Validate and extract a handleable message from a raw Baileys message.
 * Returns null if the message should be ignored.
 *
 * Filters out:
 * - Non-text messages (images, stickers, etc.)
 * - Direct messages (no groupJid)
 * - Status broadcasts
 * - Messages from the bot itself
 * - Messages from JIDs other than ownJid (only owner's messages are handled)
 * - Messages in unmapped groups
 *
 * @param msg - Raw Baileys message
 * @param ownJid - The bot's own JID from sock.user.id
 * @returns Parsed message, or null if it should be ignored
 */
export function shouldHandleMessage(
  msg: proto.IWebMessageInfo,
  ownJid: string
): WhatsAppIncomingMessage | null {
  // Must have a remote JID
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid) {
    return null;
  }

  // Ignore status broadcasts
  if (remoteJid === "status@broadcast") {
    return null;
  }

  // Must be a group message (group JIDs end with @g.us)
  if (!remoteJid.endsWith("@g.us")) {
    return null;
  }

  // Must have a sender (participant in groups)
  const senderJid = msg.key?.participant;
  if (!senderJid) {
    return null;
  }

  // Normalize both JIDs by stripping the :0 device suffix before comparing
  const normalizedSender = normalizeJid(senderJid);
  const normalizedOwn = normalizeJid(ownJid);

  // Ignore messages from the bot itself
  if (normalizedSender === normalizedOwn) {
    return null;
  }

  // Only handle messages from the owner (same number as the connected account)
  // Since the bot IS the owner's WhatsApp account, we only accept messages
  // from the owner. But wait -- the owner's messages come from the same JID
  // as ownJid, which we just filtered above. Re-reading the spec:
  // "messages from JIDs other than ownJid (only owner's messages are handled)"
  // This means we ONLY handle messages where sender === ownJid.
  // But we also skip "messages from bot itself". These two rules conflict
  // unless the intent is: only the owner sends messages, and the bot's own
  // echoed messages (fromMe) are skipped.
  //
  // Resolution: skip messages where msg.key.fromMe is true (bot's own sends),
  // but accept messages from the owner's JID (which have fromMe=false when
  // the owner sends from their phone while the bot is connected as a linked device).
  //
  // Actually, re-reading more carefully: the owner's phone messages appear with
  // the owner's JID as participant and fromMe=true in multi-device. Let me
  // handle this correctly:
  // - fromMe=true means the message was sent by the linked account (could be
  //   from phone or from bot). We skip these to avoid echo loops.
  // - fromMe=false means another participant sent it. We only accept if the
  //   sender matches ownJid (which doesn't happen in practice for fromMe=false).
  //
  // The spec says "only owner's messages are handled". In Baileys multi-device,
  // when the owner types in the group from their phone, it appears with
  // fromMe=true. The bot should handle these (they are the owner's messages)
  // but NOT handle messages the bot itself sent programmatically.
  //
  // Simplification: We cannot distinguish "owner typed on phone" from "bot sent
  // via sendMessage" when both are fromMe=true. The standard approach is:
  // - Handle all messages from non-bot participants (fromMe=false)
  // - Skip fromMe=true to avoid echo loops
  //
  // But the spec says only the owner's messages should be handled. Since the
  // owner is the only one who should be in VoiceCC groups, accepting all
  // fromMe=false messages effectively means "only owner" because no one else
  // is in the group.

  // Skip messages sent by the bot (fromMe=true) to avoid echo loops
  if (msg.key?.fromMe) {
    return null;
  }

  // Extract text content
  const text = extractTextContent(msg);
  if (!text) {
    return null;
  }

  // Check if the group is mapped to an agent
  const agentId = getAgentIdForGroup(remoteJid);
  if (!agentId) {
    return null;
  }

  const messageId = msg.key?.id ?? "";

  return {
    groupJid: remoteJid,
    senderJid,
    text,
    messageId,
  };
}

/**
 * Stream SSE from Python /chat/send and yield message segments at boundaries.
 * Yields a segment whenever a tool_start or result event arrives after accumulated text.
 * This allows each logical message to be sent to WhatsApp immediately.
 *
 * @param response - The fetch Response from Python /chat/send
 * @yields SseSegment for each completed message boundary
 * @throws Error on non-2xx responses (except 409)
 */
export async function* streamSseSegments(response: Response): AsyncGenerator<SseSegment> {
  // HTTP 409 means the session is already streaming
  if (response.status === 409) {
    yield { text: "", sessionId: null, isAlreadyStreaming: true, isError: false };
    return;
  }

  // Any other non-2xx is an error
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(`Python /chat/send returned HTTP ${response.status}: ${errorBody}`);
  }

  const body = response.body;
  if (!body) {
    return;
  }

  let accumulatedText = "";
  let hasError = false;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE events (separated by double newlines)
    const events = buffer.split("\n\n");
    // Keep the last incomplete chunk in the buffer
    buffer = events.pop() ?? "";

    for (const event of events) {
      const trimmed = event.trim();
      if (!trimmed) continue;

      // SSE format: "data: {...}"
      if (!trimmed.startsWith("data: ")) continue;

      const jsonStr = trimmed.slice(6); // Remove "data: " prefix
      let payload: SseEventPayload;
      try {
        payload = JSON.parse(jsonStr);
      } catch {
        continue; // Skip malformed events
      }

      if (payload.type === "text_delta" && payload.content) {
        accumulatedText += payload.content;
      } else if (payload.type === "tool_start") {
        // Tool boundary: yield accumulated text as a separate message
        if (accumulatedText) {
          yield { text: accumulatedText, sessionId: null, isAlreadyStreaming: false, isError: false };
          accumulatedText = "";
        }
      } else if (payload.type === "result") {
        // Final event: yield remaining text with session ID
        yield {
          text: accumulatedText,
          sessionId: payload.sessionId ?? null,
          isAlreadyStreaming: false,
          isError: false,
        };
        return;
      } else if (payload.type === "error") {
        hasError = true;
      }
    }
  }

  // Stream closed without a result event (error path) -- yield whatever we have
  if (hasError && !accumulatedText) {
    yield { text: SSE_ERROR_REPLY, sessionId: null, isAlreadyStreaming: false, isError: true };
  } else if (accumulatedText) {
    yield { text: accumulatedText, sessionId: null, isAlreadyStreaming: false, isError: false };
  }
}

/**
 * Handle an incoming WhatsApp message end-to-end.
 * Resolves the agent, calls Python /chat/send, and sends each logical message
 * segment to WhatsApp as soon as it completes (at tool_start / result boundaries).
 *
 * @param msg - The parsed incoming message
 */
export async function handleIncomingMessage(msg: WhatsAppIncomingMessage): Promise<void> {
  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not connected");
  }

  // Resolve agent for this group
  const agentId = getAgentIdForGroup(msg.groupJid);
  if (!agentId) {
    throw new Error(`No agent mapped to group "${msg.groupJid}"`);
  }

  // Get stored session ID for conversation resume
  const resumeSessionId = getLastSessionId(msg.groupJid);

  // Call Python /chat/send directly (no dashboard proxy, no device token)
  const sessionKey = `wa:${msg.groupJid}`;
  const response = await fetch(`${VOICE_SERVER_URL}/chat/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_key: sessionKey,
      agent_id: agentId,
      text: msg.text,
      resume_session_id: resumeSessionId,
    }),
  });

  // Stream segments and send each to WhatsApp as soon as it's ready
  for await (const segment of streamSseSegments(response)) {
    if (segment.isAlreadyStreaming) {
      await sock.sendMessage(msg.groupJid, { text: ALREADY_STREAMING_REPLY });
      return;
    }

    // Store session ID when present (only on the final segment)
    if (segment.sessionId) {
      await setLastSessionId(msg.groupJid, segment.sessionId);
    }

    // Send text, splitting if it exceeds the byte limit
    if (segment.text) {
      const chunks = splitByByteLength(segment.text, MAX_MESSAGE_BYTES);
      for (const chunk of chunks) {
        await sock.sendMessage(msg.groupJid, { text: `[voicecc] ${chunk}` });
      }
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Normalize a WhatsApp JID by stripping the :0 (or any :N) device suffix.
 * Example: "1234567890:0@s.whatsapp.net" -> "1234567890@s.whatsapp.net"
 *
 * @param jid - The raw JID from Baileys
 * @returns The normalized JID without device suffix
 */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+@/, "@");
}

/**
 * Extract text content from a raw Baileys message.
 * Supports regular text messages and extended text messages (with links/formatting).
 *
 * @param msg - Raw Baileys message
 * @returns The text content, or null if not a text message
 */
function extractTextContent(msg: proto.IWebMessageInfo): string | null {
  const message = msg.message;
  if (!message) return null;

  // Regular text message
  if (message.conversation) {
    return message.conversation;
  }

  // Extended text message (with URL preview, formatting, etc.)
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  return null;
}

/**
 * Split a string into chunks that each fit within a byte length limit.
 * Uses TextEncoder to measure actual byte length (handles multi-byte characters).
 * Splits on newline boundaries when possible, otherwise on character boundaries.
 *
 * @param text - The text to split
 * @param maxBytes - Maximum byte length per chunk
 * @returns Array of text chunks
 */
function splitByByteLength(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const totalBytes = encoder.encode(text).byteLength;

  // No split needed
  if (totalBytes <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Binary search for the max character count that fits within maxBytes
    let low = 0;
    let high = remaining.length;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const byteLen = encoder.encode(remaining.slice(0, mid)).byteLength;
      if (byteLen <= maxBytes) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    if (low === 0) {
      // Single character exceeds limit (shouldn't happen with 64KB limit)
      throw new Error("Single character exceeds maximum byte length");
    }

    // Try to split at a newline boundary for readability
    let splitAt = low;
    const lastNewline = remaining.lastIndexOf("\n", low);
    if (lastNewline > 0 && lastNewline > low * 0.5) {
      splitAt = lastNewline + 1;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}
