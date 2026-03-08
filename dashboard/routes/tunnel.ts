/**
 * Tunnel management API routes.
 *
 * Delegates to the tunnel service for cloudflared lifecycle operations:
 * - GET /check -- always true (cloudflared npm package auto-downloads the binary)
 * - GET /status -- running state + public URL
 * - POST /start -- start tunnel
 * - POST /stop -- stop tunnel
 */

import { Hono } from "hono";
import {
  isTunnelRunning,
  getTunnelUrl,
  getTunnelStartedAt,
  startTunnel,
  stopTunnel,
} from "../../server/services/tunnel.js";
import { readEnv, writeEnvKey } from "../../server/services/env.js";

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

  /** Always true -- the cloudflared npm package auto-downloads the binary */
  app.get("/check", (c) => {
    return c.json({ installed: true });
  });

  /** Get tunnel running status and URL */
  app.get("/status", (c) => {
    return c.json({ running: isTunnelRunning(), url: getTunnelUrl(), startedAt: getTunnelStartedAt() });
  });

  /** Start tunnel and persist TUNNEL_ENABLED=true */
  app.post("/start", async (c) => {
    const envVars = await readEnv();
    const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

    try {
      const url = await startTunnel(port);
      await writeEnvKey("TUNNEL_ENABLED", "true");
      return c.json({ success: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start tunnel";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop tunnel and persist TUNNEL_ENABLED=false */
  app.post("/stop", async (c) => {
    stopTunnel();
    await writeEnvKey("TUNNEL_ENABLED", "false");
    return c.json({ success: true });
  });

  return app;
}
