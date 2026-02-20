/**
 * ngrok management API routes.
 *
 * Delegates to the ngrok service for tunnel lifecycle operations:
 * - GET /check -- is ngrok installed
 * - POST /authtoken -- configure ngrok authtoken
 * - GET /status -- running state + public URL
 * - POST /start -- start ngrok tunnel
 * - POST /stop -- stop ngrok tunnel
 */

import { Hono } from "hono";
import {
  checkNgrokInstalled,
  configureNgrokAuthtoken,
  isNgrokRunning,
  getNgrokUrl,
  startNgrok,
  stopNgrok,
} from "../../services/ngrok.js";
import { readEnv } from "../../services/env.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for ngrok operations.
 *
 * @returns Hono instance with check, authtoken, status, start, stop routes
 */
export function ngrokRoutes(): Hono {
  const app = new Hono();

  /** Check if ngrok is installed */
  app.get("/check", async (c) => {
    const installed = await checkNgrokInstalled();
    return c.json({ installed });
  });

  /** Configure ngrok authtoken */
  app.post("/authtoken", async (c) => {
    const body = await c.req.json<{ token?: string }>();
    if (!body.token || typeof body.token !== "string") {
      return c.json({ error: "Missing 'token' in request body" }, 400);
    }

    const result = await configureNgrokAuthtoken(body.token);
    if (result.ok) {
      return c.json({ success: true, output: result.output });
    }
    return c.json({ error: result.output }, 500);
  });

  /** Get ngrok running status and URL */
  app.get("/status", (c) => {
    return c.json({ running: isNgrokRunning(), url: getNgrokUrl() });
  });

  /** Start ngrok tunnel */
  app.post("/start", async (c) => {
    const envVars = await readEnv();
    const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

    try {
      const url = await startNgrok(port);
      return c.json({ success: true, url });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start ngrok";
      return c.json({ error: message }, 500);
    }
  });

  /** Stop ngrok tunnel */
  app.post("/stop", (c) => {
    stopNgrok();
    return c.json({ success: true });
  });

  return app;
}
