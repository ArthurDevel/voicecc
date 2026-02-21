/**
 * Claude Code authentication probe route.
 *
 * Runs `claude mcp list` to check whether the user is authenticated.
 * This command is free (no API call), creates no conversation history,
 * and fails with a non-zero exit code when not logged in.
 *
 * - GET /    -- probe and return { authenticated: boolean }
 * - POST /login -- open Terminal.app with `claude` for interactive login
 */

import { Hono } from "hono";
import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Run `claude mcp list` and check if it succeeds.
 *
 * @returns true if claude exits 0 (authenticated), false otherwise
 */
async function probeClaudeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ["mcp", "list"], { timeout: 15_000 }, (err) => {
      resolve(!err);
    });
  });
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for Claude Code auth testing.
 *
 * @returns Hono instance with GET / route
 */
export function authRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const authenticated = await probeClaudeAuth();
    return c.json({ authenticated });
  });

  /** Open Terminal.app with `claude` for interactive login */
  app.post("/login", async (c) => {
    const script = `tell application "Terminal"
  activate
  do script "${CLAUDE_BIN}"
end tell`;

    return new Promise((resolve) => {
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
