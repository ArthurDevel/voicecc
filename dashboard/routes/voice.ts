/**
 * Proxy route group for voice/WebRTC signaling to the Python server.
 *
 * Validates device token auth in Node.js, then proxies WebRTC signaling
 * requests to the Python SmallWebRTC server. The Python server is
 * localhost-only; all external traffic goes through this proxy with auth.
 *
 * Responsibilities:
 * - Validate device tokens on incoming requests
 * - Proxy WebRTC signaling requests to the Python server (port 7860)
 * - Read VOICE_SERVER_URL from environment
 */

import { Hono } from "hono";

import { isValidDeviceToken } from "../../server/services/device-pairing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base URL for the Python SmallWebRTC server */
const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7860";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for voice proxy.
 * Validates device token, then proxies WebRTC signaling to the Python server.
 *
 * @returns Hono instance with voice proxy routes
 */
export function voiceRoutes(): Hono {
  const app = new Hono();

  /**
   * Proxy all WebRTC signaling requests to the Python SmallWebRTC server.
   * Supports both GET and POST for signaling endpoints like /offer, /ice, etc.
   */
  app.all("/*", async (c) => {
    // Extract device token from query param or Authorization header
    const tokenFromQuery = c.req.query("token");
    const authHeader = c.req.header("authorization") ?? "";
    const tokenFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const token = tokenFromQuery || tokenFromHeader;

    if (!token || !isValidDeviceToken(token)) {
      return c.json({ error: "Invalid device token" }, 401);
    }

    // Build the target URL on the Python server.
    // Hono gives us the full path (e.g. /api/voice/offer). Strip the mount
    // prefix (/api/voice) and prepend /api so it maps to Pipecat's /api/offer.
    const fullPath = c.req.path;
    const path = "/api" + fullPath.replace(/^\/api\/voice/, "");
    const queryString = new URL(c.req.url).search;
    const targetUrl = `${VOICE_SERVER_URL}${path}${queryString}`;

    try {
      const headers: Record<string, string> = {};
      const contentType = c.req.header("content-type");
      if (contentType) {
        headers["Content-Type"] = contentType;
      }

      const fetchOptions: RequestInit = {
        method: c.req.method,
        headers,
      };

      // Forward body for non-GET requests
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        fetchOptions.body = await c.req.text();
      }

      const response = await fetch(targetUrl, fetchOptions);

      // Forward the response back
      const responseHeaders = new Headers();
      response.headers.forEach((value, key) => {
        responseHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Proxy error";
      console.error(`[voice-proxy] Error proxying to ${targetUrl}: ${msg}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  return app;
}
