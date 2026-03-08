/**
 * Browser call server management API routes.
 *
 * Manages the lifecycle of the browser-server (direct WebSocket audio):
 * - GET /status -- browser-server running state + tunnel URL
 * - POST /start -- start browser-server (requires tunnel)
 * - POST /stop -- stop browser-server
 */

import { Hono } from "hono";
import { startBrowserCallServer, stopBrowserCallServer, getBrowserCallStatus, isBrowserCallRunning } from "../../server/services/browser-call-manager.js";
import { getTunnelUrl, isTunnelRunning } from "../../server/services/tunnel.js";

// ============================================================================
// STATE
// ============================================================================

/** Dashboard port -- set by server.ts when calling setDashboardPort */
let dashboardPort = 0;

/**
 * Set the dashboard port for browser-server proxying.
 * Called by server.ts after the Hono server starts listening.
 *
 * @param port - The dashboard server port
 */
export function setDashboardPort(port: number): void {
  dashboardPort = port;
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for browser call operations.
 *
 * @returns Hono instance with status, start, stop routes
 */
export function browserCallRoutes(): Hono {
  const app = new Hono();

  /** Get browser call server status + tunnel URL */
  app.get("/status", (c) => {
    const status = getBrowserCallStatus();
    return c.json({ ...status, tunnelUrl: getTunnelUrl() });
  });

  /** Start browser call integration (requires tunnel) */
  app.post("/start", async (c) => {
    try {
      if (!isTunnelRunning()) {
        return c.json({ error: "Tunnel is not enabled. Enable it in Settings > General first." }, 400);
      }

      if (!isBrowserCallRunning()) {
        await startBrowserCallServer(dashboardPort);
      }

      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop browser call integration */
  app.post("/stop", (c) => {
    stopBrowserCallServer();
    return c.json({ success: true });
  });

  return app;
}
