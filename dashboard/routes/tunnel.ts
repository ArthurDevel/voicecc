/**
 * Tunnel management API routes.
 *
 * Delegates to the tunnel service for cloudflared lifecycle operations:
 * - GET /check -- is cloudflared installed
 * - GET /status -- running state + public URL
 * - POST /start -- start tunnel
 * - POST /stop -- stop tunnel
 */

import { Hono } from "hono";
import {
  checkCloudflaredInstalled,
  isTunnelRunning,
  getTunnelUrl,
  getTunnelStartedAt,
  startTunnel,
  stopTunnel,
} from "../../services/tunnel.js";
import { readEnv } from "../../services/env.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for tunnel operations.
 *
 * @returns Hono instance with check, status, start, stop routes
 */
export function tunnelRoutes(): Hono {
  const app = new Hono();

  /** Check if cloudflared is installed */
  app.get("/check", async (c) => {
    const installed = await checkCloudflaredInstalled();
    return c.json({ installed });
  });

  /** Get tunnel running status and URL */
  app.get("/status", (c) => {
    return c.json({ running: isTunnelRunning(), url: getTunnelUrl(), startedAt: getTunnelStartedAt() });
  });

  /** Start tunnel */
  app.post("/start", async (c) => {
    const envVars = await readEnv();
    const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

    try {
      const url = await startTunnel(port);
      return c.json({ success: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start tunnel";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop tunnel */
  app.post("/stop", (c) => {
    stopTunnel();
    return c.json({ success: true });
  });

  return app;
}
