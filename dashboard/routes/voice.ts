/**
 * Voice server launch route.
 *
 * Opens Terminal.app and starts the voice server process:
 * - POST /start -- opens Terminal via osascript
 */

import { Hono } from "hono";
import { execFile } from "child_process";

// ============================================================================
// CONSTANTS
// ============================================================================

const VOICE_CMD = `cd ${process.cwd()} && npx tsx server/voice/index.ts`;

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for voice operations.
 *
 * @returns Hono instance with POST /start route
 */
export function voiceRoutes(): Hono {
  const app = new Hono();

  /** Open Terminal.app and start the voice server */
  app.post("/start", async (c) => {
    const script = `tell application "Terminal"
  activate
  do script "${VOICE_CMD}"
end tell`;

    return new Promise<Response>((resolve) => {
      execFile("osascript", ["-e", script], (err) => {
        if (err) {
          resolve(c.json({ error: err.message }, 500));
          return;
        }
        resolve(c.json({ success: true }));
      });
    });
  });

  return app;
}
