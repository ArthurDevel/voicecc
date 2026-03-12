/**
 * Hono routes for text chat with agents via SSE.
 *
 * Thin route layer that delegates to the chat session manager in
 * server/voice/chat-server.ts. Handles request parsing, token validation,
 * and SSE streaming.
 *
 * - POST /send: sends a message, streams response as SSE
 * - POST /close: explicitly closes a session
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { getOrCreateSession, streamMessage, closeSession, hasSession } from "../../server/voice/chat-server.js";
import { isValidDeviceToken } from "../../server/services/device-pairing.js";

// ============================================================================
// TYPES
// ============================================================================

/** Request body for POST /send */
interface ChatSendBody {
  token: string;
  agentId?: string;
  text: string;
}

/** Request body for POST /close */
interface ChatCloseBody {
  token: string;
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for text chat.
 *
 * @returns Hono instance with /send and /close routes
 */
export function chatRoutes(): Hono {
  const app = new Hono();

  /** POST /send - send a message and stream Claude's response as SSE */
  app.post("/send", async (c) => {
    let body: ChatSendBody;
    try {
      body = await c.req.json<ChatSendBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    // Validate required fields
    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Missing or empty 'text' field" }, 400);
    }
    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' field" }, 400);
    }

    // Validate device token (localhost bypass via x-forwarded-for header set by voice-server proxy)
    const forwarded = c.req.header("x-forwarded-for") ?? "";
    const isLocalhost = forwarded === "127.0.0.1";

    if (!isLocalhost && !isValidDeviceToken(body.token)) {
      return c.json({ error: "Invalid device token" }, 401);
    }

    const sessionKey = body.token;
    const text = body.text.trim();

    // Get or create session
    try {
      await getOrCreateSession(sessionKey, body.agentId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create session";
      console.error(`Failed to create chat session for token ${sessionKey}:`, err);
      return c.json({ error: msg }, 503);
    }

    // Stream response as SSE
    try {
      const generator = streamMessage(sessionKey, text);

      return streamSSE(c, async (stream) => {
        for await (const event of generator) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
      });
    } catch (err) {
      // streamMessage throws "ALREADY_STREAMING" if concurrent
      if (err instanceof Error && err.message === "ALREADY_STREAMING") {
        return c.json({ error: "Already streaming a response. Wait for it to complete." }, 409);
      }
      const msg = err instanceof Error ? err.message : "Stream error";
      return c.json({ error: msg }, 500);
    }
  });

  /** POST /close - explicitly close a chat session */
  app.post("/close", async (c) => {
    let body: ChatCloseBody;
    try {
      body = await c.req.json<ChatCloseBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' field" }, 400);
    }

    if (!hasSession(body.token)) {
      return c.json({ ok: true, message: "No active session" });
    }

    try {
      await closeSession(body.token);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to close session";
      console.error(`Error closing chat session for token ${body.token}:`, err);
      return c.json({ error: msg }, 500);
    }
  });

  return app;
}
