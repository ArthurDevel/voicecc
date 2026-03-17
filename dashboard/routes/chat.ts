/**
 * Hono routes for text chat -- proxied to the Python voice server.
 *
 * Validates device tokens in Node.js, then proxies chat requests to the
 * Python server's /chat/* endpoints. The Python server manages Claude
 * sessions and streams responses.
 *
 * - POST /send: proxies to Python /chat/send, returns SSE stream
 * - POST /stop: proxies to Python /chat/stop
 * - POST /close: proxies to Python /chat/close
 */

import { Hono } from "hono";

import { isValidDeviceToken } from "../../server/services/device-pairing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base URL for the Python FastAPI server */
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

// ============================================================================
// TYPES
// ============================================================================

/** Request body for POST /send */
interface ChatSendBody {
  token: string;
  agentId?: string;
  text: string;
}

/** Request body for POST /stop and /close */
interface ChatTokenBody {
  token: string;
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for text chat.
 * Validates auth, then proxies to the Python server.
 *
 * @returns Hono instance with /send, /stop, and /close routes
 */
export function chatRoutes(): Hono {
  const app = new Hono();

  /** POST /send - proxy to Python /chat/send, return SSE stream */
  app.post("/send", async (c) => {
    let body: ChatSendBody;
    try {
      body = await c.req.json<ChatSendBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "Missing or empty 'text' field" }, 400);
    }
    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' field" }, 400);
    }

    // Validate device token (localhost bypass via x-forwarded-for)
    const forwarded = c.req.header("x-forwarded-for") ?? "";
    const isLocalhost = forwarded === "127.0.0.1";

    if (!isLocalhost && !isValidDeviceToken(body.token)) {
      return c.json({ error: "Invalid device token" }, 401);
    }

    // Proxy to Python server
    try {
      const response = await fetch(`${VOICE_SERVER_URL}/chat/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_key: body.token,
          agent_id: body.agentId,
          text: body.text.trim(),
        }),
      });

      if (!response.ok && !response.headers.get("content-type")?.includes("text/event-stream")) {
        const errorData = await response.json().catch(() => ({ error: "Voice server error" }));
        return c.json(errorData, response.status as 400 | 409 | 500 | 503);
      }

      // Forward the SSE stream
      const headers = new Headers();
      headers.set("Content-Type", "text/event-stream");
      headers.set("Cache-Control", "no-cache");
      headers.set("Connection", "keep-alive");

      return new Response(response.body, { status: 200, headers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice server unavailable";
      console.error(`[chat-proxy] Error proxying /chat/send: ${msg}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  /** POST /stop - proxy to Python /chat/stop */
  app.post("/stop", async (c) => {
    let body: ChatTokenBody;
    try {
      body = await c.req.json<ChatTokenBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' field" }, 400);
    }

    try {
      const response = await fetch(`${VOICE_SERVER_URL}/chat/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_key: body.token }),
      });

      const data = await response.json();
      return c.json(data, response.status as 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice server unavailable";
      console.error(`[chat-proxy] Error proxying /chat/stop: ${msg}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  /** POST /close - proxy to Python /chat/close */
  app.post("/close", async (c) => {
    let body: ChatTokenBody;
    try {
      body = await c.req.json<ChatTokenBody>();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' field" }, 400);
    }

    try {
      const response = await fetch(`${VOICE_SERVER_URL}/chat/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_key: body.token }),
      });

      const data = await response.json();
      return c.json(data, response.status as 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Voice server unavailable";
      console.error(`[chat-proxy] Error proxying /chat/close: ${msg}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  return app;
}
