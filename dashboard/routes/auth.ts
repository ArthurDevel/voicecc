/**
 * Claude Code authentication probe route.
 *
 * Runs `claude -p "hi" --output-format json` to check whether the user
 * is authenticated. When logged out this returns instantly (~30ms) with
 * exit code 1 and `is_error: true`. When logged in it starts an API call,
 * so we use a short timeout and kill the process -- if it's still running
 * after the deadline, the user is authenticated.
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

/** When not logged in the CLI exits in ~30ms. Give it 3s before assuming authenticated. */
const PROBE_TIMEOUT_MS = 3_000;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Run `claude -p "hi" --output-format json` with a short timeout.
 *
 * - Logged out: exits 1 instantly with "Not logged in" in the result.
 * - Logged in: starts an API call (hangs until timeout). We kill it and
 *   treat that as authenticated.
 *
 * @returns true if authenticated, false otherwise
 */
async function probeClaudeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = execFile(
      CLAUDE_BIN,
      ["-p", "hi", "--output-format", "json"],
      { timeout: PROBE_TIMEOUT_MS },
      (err, stdout) => {
        if (!err) {
          // Exited 0 -- logged in (unlikely to finish that fast, but valid)
          resolve(true);
          return;
        }

        // If killed by our timeout, the process was busy making an API call -> authenticated
        if (err.killed) {
          resolve(true);
          return;
        }

        // Exited with error -- check if it's the "Not logged in" message
        try {
          const json = JSON.parse(stdout);
          if (json.is_error && typeof json.result === "string" && json.result.includes("Not logged in")) {
            resolve(false);
            return;
          }
        } catch {
          // couldn't parse JSON, fall through
        }

        // Any other error -- assume not authenticated
        resolve(false);
      },
    );
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
