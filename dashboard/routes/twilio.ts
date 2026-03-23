/**
 * Twilio PSTN server management and webhook proxy API routes.
 *
 * Manages the Twilio integration lifecycle and proxies Twilio webhooks
 * to the Python voice server. Keeps Twilio signature validation in Node.js.
 *
 * Responsibilities:
 * - GET /status -- server running state and tunnel URL
 * - POST /start -- start twilio integration (requires tunnel)
 * - POST /stop -- stop twilio integration
 * - GET /phone-numbers -- fetch phone numbers from Twilio API
 * - POST /test-call -- place a test call
 * - GET /heartbeat/status -- proxy heartbeat status from Python server
 */

import { Hono } from "hono";
import twilioSdk from "twilio";
import { readEnv } from "../../server/services/env.js";
import { startTwilioServer, stopTwilioServer, getStatus } from "../../server/services/twilio-manager.js";
import { getTunnelUrl, isTunnelRunning } from "../../server/services/tunnel.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base URL for the Python FastAPI server */
const VOICE_API_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

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
 * @returns Hono instance with status, start, stop, phone-numbers, webhook proxy routes
 */
export function twilioRoutes(): Hono {
  const app = new Hono();

  /** Get Twilio server status */
  app.get("/status", async (c) => {
    const status = await getStatus();
    return c.json({ running: status.running, tunnelUrl: getTunnelUrl() });
  });

  /** Start Twilio server (requires tunnel to be running) */
  app.post("/start", async (c) => {
    try {
      if (!isTunnelRunning()) {
        return c.json({ error: "Tunnel is not enabled. Enable it in Settings > General first." }, 400);
      }
      const status = await getStatus();
      if (!status.running) {
        await startTwilioServer(dashboardPort, getTunnelUrl() ?? undefined);
      }
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop Twilio integration */
  app.post("/stop", (c) => {
    stopTwilioServer();
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

  /** Place a test call to verify Twilio setup */
  app.post("/test-call", async (c) => {
    const body = await c.req.json<{ to: string }>();
    const to = body.to?.trim();
    if (!to) {
      return c.json({ error: "Phone number is required" }, 400);
    }

    const envVars = await readEnv();
    const accountSid = envVars.TWILIO_ACCOUNT_SID;
    const authToken = envVars.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return c.json({ error: "Twilio credentials not configured" }, 400);
    }

    try {
      const fromNumber = envVars.TWILIO_PHONE_NUMBER;
      if (!fromNumber) {
        return c.json({ error: "No Twilio phone number selected. Select one in step 2." }, 400);
      }

      const client = twilioSdk(accountSid, authToken);
      const call = await client.calls.create({
        to,
        from: fromNumber,
        twiml: '<Response><Say>This is a test call from your voice assistant. If you can hear this, your Twilio setup is working correctly. Goodbye!</Say></Response>',
      });

      return c.json({ success: true, callSid: call.sid });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to place call";
      return c.json({ error: message }, 500);
    }
  });

  /**
   * Proxy Twilio incoming-call webhook to the Python server.
   * Validates Twilio signature in Node.js before forwarding.
   */
  app.post("/incoming-call", async (c) => {
    const envVars = await readEnv();
    const authToken = envVars.TWILIO_AUTH_TOKEN;
    const tunnelUrl = getTunnelUrl();

    if (!authToken) {
      console.log("[twilio] Rejected incoming call: TWILIO_AUTH_TOKEN not set");
      return c.text("Server misconfigured", 500);
    }

    if (!tunnelUrl) {
      console.log("[twilio] Rejected incoming call: no tunnel URL available");
      return c.text("Server misconfigured", 500);
    }

    // Validate Twilio signature
    const rawBody = await c.req.text();
    const params = parseUrlEncodedBody(rawBody);
    const webhookUrl = tunnelUrl.replace(/\/$/, "") + c.req.path;
    const signature = c.req.header("x-twilio-signature") ?? "";

    if (!signature || !twilioSdk.validateRequest(authToken, signature, webhookUrl, params)) {
      console.log("[twilio] Rejected incoming call: invalid Twilio signature");
      return c.text("Forbidden", 403);
    }

    // Proxy to Python server
    try {
      const response = await fetch(`${VOICE_API_URL}/twilio/incoming-call`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: rawBody,
      });

      const responseText = await response.text();
      return new Response(responseText, {
        status: response.status,
        headers: { "Content-Type": response.headers.get("content-type") ?? "text/xml" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Proxy error";
      console.error(`[twilio] Error proxying incoming-call: ${message}`);
      return c.text("Voice server unavailable", 502);
    }
  });

  /** Proxy heartbeat status from the Python server */
  app.get("/heartbeat/status", async (c) => {
    try {
      const response = await fetch(`${VOICE_API_URL}/heartbeat/status`);
      const data = await response.json();
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Proxy error";
      console.error(`[twilio] Error proxying heartbeat status: ${message}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  return app;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse a URL-encoded POST body into a key-value record.
 *
 * @param body - URL-encoded string
 * @returns Record of decoded key-value pairs
 */
function parseUrlEncodedBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!body) return params;

  for (const pair of body.split("&")) {
    const [key, value] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
    }
  }

  return params;
}
