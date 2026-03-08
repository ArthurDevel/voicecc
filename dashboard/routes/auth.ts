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
 */

import { Hono } from "hono";
import { spawn } from "child_process";
import { writeEnvKey } from "../../server/services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = "claude";
const PROBE_TIMEOUT_MS = 5_000;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Run `claude -p "hi" --output-format json` with stdin closed.
 *
 * - Logged out: exits 1 instantly (~30ms) with "Not logged in" in the JSON result.
 * - Logged in: completes the API call and exits 0 with a JSON response.
 * - Safety timeout at 5s: kills the process and assumes authenticated.
 *
 * @returns true if authenticated, false otherwise
 */
async function probeClaudeAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const child = spawn(CLAUDE_BIN, ["-p", "hi", "--output-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", () => {
      clearTimeout(timer);
      done(false);
    });

    const timer = setTimeout(() => {
      child.kill();
      done(true);
    }, PROBE_TIMEOUT_MS);

    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 0) {
        done(true);
        return;
      }

      try {
        const json = JSON.parse(stdout);
        if (json.is_error && typeof json.result === "string" && json.result.includes("Not logged in")) {
          done(false);
          return;
        }
      } catch {
        // couldn't parse JSON
      }

      done(false);
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

  /**
   * Save a Claude OAuth token to .env and re-probe authentication.
   *
   * @param token - The OAuth token from `claude setup-token`
   * @returns { authenticated: boolean }
   */
  app.post("/token", async (c) => {
    const { token } = await c.req.json<{ token: string }>();

    if (!token || typeof token !== "string") {
      return c.json({ error: "Token is required" }, 400);
    }

    const cleanToken = token.replace(/[\n\r\s]/g, "");

    await writeEnvKey("CLAUDE_CODE_OAUTH_TOKEN", cleanToken);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = cleanToken;

    const authenticated = await probeClaudeAuth();
    return c.json({ authenticated });
  });

  return app;
}
