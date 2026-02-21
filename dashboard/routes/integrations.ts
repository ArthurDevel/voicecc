/**
 * Integration enable/disable API routes.
 *
 * Manages the enabled state of integrations (Twilio, Browser Call).
 * Enabling an integration persists the flag to .env and immediately starts
 * the service (plus ngrok as a dependency). Disabling stops it.
 *
 * - GET / -- returns enabled state for each integration
 * - POST /:name -- sets enabled state and starts/stops the service
 */

import { Hono } from "hono";
import { readEnv, writeEnvKey } from "../../services/env.js";
import { startTwilioServer, stopTwilioServer, isRunning as isTwilioRunning } from "../../services/twilio-manager.js";
import { startBrowserCallServer, stopBrowserCallServer, isBrowserCallRunning } from "../../services/browser-call-manager.js";
import { startNgrok, stopNgrok, isNgrokRunning, getNgrokUrl } from "../../services/ngrok.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Map of integration names to their .env key */
const INTEGRATION_ENV_KEYS: Record<string, string> = {
  twilio: "TWILIO_ENABLED",
  "browser-call": "BROWSER_CALL_ENABLED",
};

// ============================================================================
// STATE
// ============================================================================

/** Dashboard port -- set by server.ts after the Hono server starts */
let dashboardPort = 0;

/**
 * Set the dashboard port for starting integration servers.
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
 * Create Hono route group for integration enable/disable operations.
 *
 * @returns Hono instance with GET / and POST /:name routes
 */
export function integrationsRoutes(): Hono {
  const app = new Hono();

  /** Get enabled state for all integrations */
  app.get("/", async (c) => {
    const envVars = await readEnv();
    return c.json({
      twilio: { enabled: envVars.TWILIO_ENABLED === "true" },
      browserCall: { enabled: envVars.BROWSER_CALL_ENABLED === "true" },
    });
  });

  /** Set enabled state for a specific integration and start/stop it */
  app.post("/:name", async (c) => {
    const name = c.req.param("name");
    const envKey = INTEGRATION_ENV_KEYS[name];

    if (!envKey) {
      return c.json({ error: `Unknown integration: ${name}` }, 400);
    }

    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "Missing 'enabled' boolean in request body" }, 400);
    }

    await writeEnvKey(envKey, String(body.enabled));

    try {
      if (body.enabled) {
        await startIntegration(name);
      } else {
        stopIntegration(name);
      }
      return c.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update integration";
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Start an integration and its ngrok dependency.
 *
 * @param name - Integration name ("twilio" or "browser-call")
 */
async function startIntegration(name: string): Promise<void> {
  const envVars = await readEnv();
  const ngrokPort = parseInt(envVars.TWILIO_PORT || "8080", 10);

  // Start ngrok if not already running
  if (!isNgrokRunning()) {
    if (!envVars.NGROK_AUTHTOKEN) {
      throw new Error("NGROK_AUTHTOKEN is not configured. Set it in the integration setup first.");
    }
    await startNgrok(ngrokPort);
  }

  if (name === "twilio") {
    if (!envVars.TWILIO_AUTH_TOKEN) {
      throw new Error("TWILIO_AUTH_TOKEN is not configured. Set your Twilio credentials first.");
    }
    if (isBrowserCallRunning()) {
      throw new Error("Browser call server is already running on this port");
    }
    if (!isTwilioRunning()) {
      await startTwilioServer(dashboardPort, getNgrokUrl() ?? undefined);
    }
  } else if (name === "browser-call") {
    if (isTwilioRunning()) {
      throw new Error("Twilio server is already running on this port");
    }
    if (!isBrowserCallRunning()) {
      await startBrowserCallServer(dashboardPort);
    }
  }
}

/**
 * Stop an integration and ngrok if no other consumer needs it.
 *
 * @param name - Integration name ("twilio" or "browser-call")
 */
function stopIntegration(name: string): void {
  if (name === "twilio") {
    stopTwilioServer();
    // Only stop ngrok if browser call is also stopped
    if (!isBrowserCallRunning()) {
      stopNgrok();
    }
  } else if (name === "browser-call") {
    stopBrowserCallServer();
    // Only stop ngrok if Twilio is also stopped
    if (!isTwilioRunning()) {
      stopNgrok();
    }
  }
}
