/**
 * WebRTC device pairing API routes.
 *
 * Handles pairing code generation and device token validation:
 * - POST /generate-code -- localhost-only, create a 6-digit pairing code
 * - POST /pair -- validate a code and issue a device token
 * - GET /validate -- check if a device token is valid
 */

import { Hono } from "hono";
import {
  generatePairingCode,
  validateAndConsumeCode,
  isValidDeviceToken,
  isPairingCodeActive,
} from "../../services/device-pairing.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for WebRTC pairing operations.
 *
 * @returns Hono instance with generate-code, pair, and validate routes
 */
export function webrtcRoutes(): Hono {
  const app = new Hono();

  /** Generate a pairing code (localhost only) */
  app.post("/generate-code", (c) => {
    const remoteAddr = c.req.header("x-forwarded-for") ?? "";
    const isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1" || remoteAddr === "";
    console.log(`[webrtc] generate-code from ${remoteAddr || "(empty)"}, isLocalhost=${isLocalhost}`);

    if (!isLocalhost) {
      console.log("[webrtc] generate-code REJECTED: not localhost");
      return c.json({ error: "Pairing codes can only be generated from localhost" }, 403);
    }

    const result = generatePairingCode();
    console.log("[webrtc] generate-code OK, code:", result.code);
    return c.json(result);
  });

  /** Validate a pairing code and issue a device token */
  app.post("/pair", async (c) => {
    const body = await c.req.json<{ code?: string }>();
    console.log("[webrtc] pair request, code:", body.code);

    if (!body.code || typeof body.code !== "string") {
      console.log("[webrtc] pair REJECTED: missing code");
      return c.json({ error: "Missing 'code' in request body" }, 400);
    }

    const userAgent = c.req.header("user-agent") ?? "unknown";
    const result = validateAndConsumeCode(body.code, userAgent);

    if (!result.ok) {
      console.log("[webrtc] pair REJECTED:", result.error);
      return c.json({ error: result.error }, 401);
    }

    console.log("[webrtc] pair OK, token issued");
    return c.json({ token: result.token });
  });

  /** Check if a pairing code is still active (not yet consumed) */
  app.get("/code-status", (c) => {
    const code = c.req.query("code");
    if (!code) return c.json({ error: "Missing code query param" }, 400);
    return c.json({ active: isPairingCodeActive(code) });
  });

  /** Validate a device token from the Authorization header */
  app.get("/validate", (c) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const valid = isValidDeviceToken(token);
    console.log("[webrtc] validate token=%s...%s valid=%s", token.slice(0, 6), token.slice(-4), valid);
    return c.json({ valid });
  });

  return app;
}
