/**
 * Settings (.env) API routes.
 *
 * Read and write .env configuration with secret masking:
 * - GET / -- read .env with masked secrets
 * - POST / -- merge incoming key-value pairs into .env
 */

import { Hono } from "hono";
import { readEnv, writeEnvFile } from "../../services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Keys that should be masked when reading settings */
const MASKED_KEYS = ["TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SECRET", "ELEVENLABS_API_KEY"];

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for settings operations.
 *
 * @returns Hono instance with GET / and POST / routes
 */
export function settingsRoutes(): Hono {
  const app = new Hono();

  /** Read .env settings with masked secrets */
  app.get("/", async (c) => {
    const settings = await readEnv();

    // Mask auth tokens -- show only last 4 chars
    for (const key of MASKED_KEYS) {
      if (settings[key]) {
        const val = settings[key];
        settings[key] = val.length > 4 ? "****" + val.slice(-4) : "****" + val;
      }
    }

    return c.json(settings);
  });

  /** Merge incoming settings into .env, preserving masked values */
  app.post("/", async (c) => {
    const incoming = await c.req.json<Record<string, string>>();
    const settings = await readEnv();

    for (const [key, value] of Object.entries(incoming)) {
      // If auth tokens are masked, preserve the existing value
      if (MASKED_KEYS.includes(key) && value.startsWith("****")) {
        continue;
      }
      settings[key] = value;
    }

    await writeEnvFile(settings);
    return c.json({ success: true });
  });

  return app;
}
