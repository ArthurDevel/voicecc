/**
 * Browser call server management API routes.
 *
 * Manages the lifecycle of the browser-server (direct WebSocket audio):
 * - GET /status -- browser-server running state + ngrok URL
 * - POST /start -- start ngrok + browser-server (rejects if Twilio server holds the port)
 * - POST /stop -- stop browser-server + ngrok
 */

import { Hono } from "hono";
import { startBrowserCallServer, stopBrowserCallServer, getBrowserCallStatus, isBrowserCallRunning } from "../../services/browser-call-manager.js";
import { startNgrok, stopNgrok, getNgrokUrl, isNgrokRunning } from "../../services/ngrok.js";
import { readEnv } from "../../services/env.js";
import { isRunning as isTwilioRunning } from "../../services/twilio-manager.js";

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

  /** Get browser call server status + ngrok URL */
  app.get("/status", (c) => {
    const status = getBrowserCallStatus();
    return c.json({ ...status, ngrokUrl: getNgrokUrl() });
  });

  /** Start ngrok + browser call server */
  app.post("/start", async (c) => {
    try {
      // Port conflict check: Twilio server uses the same port
      if (isTwilioRunning()) {
        return c.json({ error: "Twilio server is already running on this port" }, 409);
      }

      const envVars = await readEnv();
      const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

      if (!isNgrokRunning()) {
        await startNgrok(port);
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

  /** Stop browser call server. Only stops ngrok if Twilio is also stopped. */
  app.post("/stop", (c) => {
    stopBrowserCallServer();
    if (!isTwilioRunning()) {
      stopNgrok();
    }
    return c.json({ success: true });
  });

  return app;
}
