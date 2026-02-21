/**
 * Twilio PSTN server management API routes.
 *
 * Manages the Twilio voice server lifecycle for PSTN phone calls:
 * - GET /status -- server running state and ngrok URL
 * - POST /start -- start ngrok + twilio server
 * - POST /stop -- stop twilio server + ngrok
 * - GET /phone-numbers -- fetch phone numbers from Twilio API
 */

import { Hono } from "hono";
import { readEnv } from "../../services/env.js";
import { startTwilioServer, stopTwilioServer, getStatus } from "../../services/twilio-manager.js";
import { startNgrok, stopNgrok, getNgrokUrl, isNgrokRunning } from "../../services/ngrok.js";
import { isBrowserCallRunning } from "../../services/browser-call-manager.js";

// ============================================================================
// STATE
// ============================================================================

/** Dashboard port -- set by server.ts when calling setDashboardPort */
let dashboardPort = 0;

/**
 * Set the dashboard port for twilio-server proxying.
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
 * Create Hono route group for Twilio operations.
 *
 * @returns Hono instance with status, start, stop, phone-numbers routes
 */
export function twilioRoutes(): Hono {
  const app = new Hono();

  /** Get Twilio server status */
  app.get("/status", async (c) => {
    const status = await getStatus();
    return c.json({ running: status.running, ngrokUrl: getNgrokUrl() });
  });

  /** Start ngrok + Twilio server */
  app.post("/start", async (c) => {
    try {
      // Port conflict check: browser-server uses the same port
      if (isBrowserCallRunning()) {
        return c.json({ error: "Browser call server is already running on this port" }, 409);
      }

      const envVars = await readEnv();
      const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

      if (!isNgrokRunning()) {
        await startNgrok(port);
      }
      const status = await getStatus();
      if (!status.running) {
        await startTwilioServer(dashboardPort, getNgrokUrl() ?? undefined);
      }
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop Twilio server and ngrok */
  app.post("/stop", (c) => {
    stopTwilioServer();
    stopNgrok();
    return c.json({ success: true });
  });

  /** Fetch phone numbers from Twilio API */
  app.get("/phone-numbers", async (c) => {
    const envVars = await readEnv();
    const accountSid = envVars.TWILIO_ACCOUNT_SID;
    const authToken = envVars.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return c.json({ error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" }, 400);
    }

    const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

    const apiRes = await fetch(apiUrl, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!apiRes.ok) {
      const body = await apiRes.text();
      return c.json({ error: `Twilio API error: ${body}` }, apiRes.status as 400);
    }

    const data = await apiRes.json();
    const numbers = (data.incoming_phone_numbers ?? []).map(
      (n: { phone_number: string; friendly_name: string }) => ({
        phoneNumber: n.phone_number,
        friendlyName: n.friendly_name,
      })
    );

    return c.json({ numbers });
  });

  return app;
}
