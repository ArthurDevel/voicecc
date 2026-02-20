/**
 * Twilio server management and WebRTC setup API routes.
 *
 * Combines twilio-manager service delegation with direct Twilio SDK calls:
 * - GET /status -- server running state and WebRTC readiness
 * - POST /start -- start ngrok + twilio server
 * - POST /stop -- stop twilio server + ngrok
 * - GET /phone-numbers -- fetch phone numbers from Twilio API
 * - POST /setup-webrtc -- create API key + TwiML app
 * - GET /token -- generate Twilio access token for browser calling
 */

import { Hono } from "hono";
import twilioSdk from "twilio";
import { readEnv, writeEnvKey } from "../../services/env.js";
import { startTwilioServer, stopTwilioServer, getStatus } from "../../services/twilio-manager.js";
import { startNgrok, stopNgrok, getNgrokUrl, isNgrokRunning } from "../../services/ngrok.js";
import { isValidDeviceToken } from "../../services/device-pairing.js";

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
 * @returns Hono instance with status, start, stop, phone-numbers, setup-webrtc, token routes
 */
export function twilioRoutes(): Hono {
  const app = new Hono();

  /** Get Twilio server status */
  app.get("/status", async (c) => {
    const status = await getStatus();
    return c.json({ ...status, ngrokUrl: getNgrokUrl() });
  });

  /** Start ngrok + Twilio server */
  app.post("/start", async (c) => {
    try {
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

  /** Auto-create Twilio API Key and TwiML Application for WebRTC */
  app.post("/setup-webrtc", async (c) => {
    const envVars = await readEnv();
    const accountSid = envVars.TWILIO_ACCOUNT_SID;
    const authToken = envVars.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      return c.json({ error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set first" }, 400);
    }

    const client = twilioSdk(accountSid, authToken);
    const ngrokUrl = getNgrokUrl();
    const voiceUrl = ngrokUrl ? `${ngrokUrl}/twilio/incoming-call` : "";

    // Create API Key if not already set
    let apiKeySid = envVars.TWILIO_API_KEY_SID;
    let apiKeySecret = envVars.TWILIO_API_KEY_SECRET;

    if (!apiKeySid || !apiKeySecret) {
      const key = await client.iam.v1.newApiKey.create({
        accountSid,
        friendlyName: "claude-voice-webrtc",
      });
      apiKeySid = key.sid;
      apiKeySecret = key.secret!;
      await writeEnvKey("TWILIO_API_KEY_SID", apiKeySid);
      await writeEnvKey("TWILIO_API_KEY_SECRET", apiKeySecret);
    }

    // Create TwiML Application if not already set
    let twimlAppSid = envVars.TWILIO_TWIML_APP_SID;

    if (!twimlAppSid) {
      const app = await client.applications.create({
        friendlyName: "Claude Voice WebRTC",
        voiceUrl: voiceUrl,
        voiceMethod: "POST",
      });
      twimlAppSid = app.sid;
      await writeEnvKey("TWILIO_TWIML_APP_SID", twimlAppSid);
    } else if (voiceUrl) {
      await client.applications(twimlAppSid).update({
        voiceUrl: voiceUrl,
        voiceMethod: "POST",
      });
    }

    return c.json({ success: true, apiKeySid, twimlAppSid });
  });

  /** Generate a Twilio Access Token for browser Voice SDK */
  app.get("/token", async (c) => {
    // Check authorization: localhost or valid device token
    const authHeader = c.req.header("authorization") ?? "";
    const deviceToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const remoteAddr = c.req.header("x-forwarded-for") ?? "";
    const isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1" || remoteAddr === "";

    if (!isLocalhost && !isValidDeviceToken(deviceToken)) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const envVars = await readEnv();
    const accountSid = envVars.TWILIO_ACCOUNT_SID;
    const apiKeySid = envVars.TWILIO_API_KEY_SID;
    const apiKeySecret = envVars.TWILIO_API_KEY_SECRET;
    const twimlAppSid = envVars.TWILIO_TWIML_APP_SID;

    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
      return c.json({ error: "WebRTC not set up. Run setup first.", needsSetup: true }, 400);
    }

    const AccessToken = twilioSdk.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
      identity: "claude-voice-browser",
      ttl: 3600,
    });

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: twimlAppSid,
        incomingAllow: false,
      })
    );

    return c.json({ token: token.toJwt() });
  });

  return app;
}
