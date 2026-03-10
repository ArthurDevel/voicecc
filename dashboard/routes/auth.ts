/**
 * Claude Code authentication routes.
 *
 * Handles auth status checks, manual token auth, and CLI OAuth login flow.
 *
 * - GET /              -- probe auth status via `claude auth status`
 * - POST /token        -- save a manually pasted token to .env
 * - POST /oauth/start  -- spawn `claude auth login`, return the OAuth URL
 * - POST /oauth/code   -- send the auth code to the spawned login process
 */

import { Hono } from "hono";
import { execFile, spawn, type ChildProcess } from "child_process";
import { writeEnvKey } from "../../server/services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = "claude";
const PROBE_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 120_000;

// ============================================================================
// TYPES
// ============================================================================

/** Auth status returned by `claude auth status`. */
interface AuthStatus {
  authenticated: boolean;
  authMethod: string;
  email?: string;
}

/** Tracks the running `claude auth login` process. */
interface PendingLogin {
  process: ChildProcess;
  url: string;
  createdAt: number;
}

// ============================================================================
// STATE
// ============================================================================

/** The currently running login process (only one at a time). */
let pendingLogin: PendingLogin | null = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get auth status via `claude auth status` JSON output.
 *
 * Tries stdout first, then stderr (some versions output there on non-zero exit).
 * Falls back to unauthenticated if parsing fails entirely.
 *
 * @returns Current authentication status
 */
async function getAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ["auth", "status"], { timeout: PROBE_TIMEOUT_MS }, (_err, stdout, stderr) => {
      const output = stdout?.trim() || stderr?.trim() || "";
      try {
        const json = JSON.parse(output);
        resolve({
          authenticated: json.loggedIn === true,
          authMethod: json.authMethod || "none",
          email: json.email || undefined,
        });
      } catch {
        resolve({ authenticated: false, authMethod: "none" });
      }
    });
  });
}

/**
 * Spawn `claude auth login` and extract the OAuth URL from its output.
 *
 * The CLI prints a URL like `https://claude.ai/oauth/authorize?...` to stdout/stderr.
 * We capture it and keep the process alive so we can later write the auth code to stdin.
 *
 * @returns The OAuth URL to show the user
 */
function spawnLoginProcess(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Kill any existing login process
    if (pendingLogin) {
      pendingLogin.process.kill();
      pendingLogin = null;
    }

    const child = spawn(CLAUDE_BIN, ["auth", "login"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let resolved = false;

    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      console.debug("[auth/login] stdout/stderr:", text.trim());

      // Look for the OAuth URL in the output
      const urlMatch = output.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
      if (urlMatch && !resolved) {
        resolved = true;
        pendingLogin = {
          process: child,
          url: urlMatch[1],
          createdAt: Date.now(),
        };
        resolve(urlMatch[1]);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start login: ${err.message}`));
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Login process exited (code ${code}) before producing a URL. Output: ${output}`));
      }
      // Clean up if the process exits after URL was captured
      if (pendingLogin?.process === child) {
        pendingLogin = null;
      }
    });

    // Timeout: if no URL appears within the timeout, kill the process
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error(`Login process did not produce a URL within ${LOGIN_TIMEOUT_MS / 1000}s. Output: ${output}`));
      }
    }, LOGIN_TIMEOUT_MS);
  });
}

/**
 * Send the auth code to the pending login process's stdin.
 *
 * After the user authenticates in their browser, the callback page shows a code.
 * We write that code to the CLI process's stdin so it can complete the login.
 *
 * @param code - The auth code from the OAuth callback
 * @returns Whether login completed successfully
 */
function sendCodeToLogin(code: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!pendingLogin) {
      resolve({ success: false, error: "No pending login process. Start the login flow first." });
      return;
    }

    const child = pendingLogin.process;
    pendingLogin = null;

    let output = "";
    let resolved = false;

    const collectOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      console.debug("[auth/login] after code:", text.trim());

      // Handle "Press Enter to continue" prompt
      if (/press enter/i.test(text)) {
        console.debug("[auth/login] detected 'Press Enter' prompt, sending newline");
        child.stdin?.write("\n");
        child.stdin?.end();
      }
    };

    child.stdout?.on("data", collectOutput);
    child.stderr?.on("data", collectOutput);

    child.on("exit", (exitCode) => {
      if (resolved) return;
      resolved = true;
      console.debug("[auth/login] process exited with code", exitCode);
      if (exitCode === 0) {
        resolve({ success: true });
      } else {
        resolve({ success: false, error: `Login process exited with code ${exitCode}. Output: ${output}` });
      }
    });

    // Write the code to stdin (don't close yet -- CLI may prompt "Press Enter")
    console.debug("[auth/login] writing code to stdin");
    child.stdin?.write(code + "\n");

    // Timeout for the code exchange
    setTimeout(() => {
      if (!child.killed) {
        child.kill();
        resolve({ success: false, error: `Login process timed out after sending code. Output: ${output}` });
      }
    }, 30_000);
  });
}

// ============================================================================
// ROUTES
// ============================================================================

export function authRoutes(): Hono {
  const app = new Hono();

  /** Get authentication status including method. */
  app.get("/", async (c) => {
    return c.json(await getAuthStatus());
  });

  /** Save a manually pasted token to .env. */
  app.post("/token", async (c) => {
    const { token } = await c.req.json<{ token: string }>();

    if (!token || typeof token !== "string") {
      return c.json({ error: "Token is required" }, 400);
    }

    const cleanToken = token.replace(/[\n\r\s]/g, "");

    await writeEnvKey("CLAUDE_CODE_OAUTH_TOKEN", cleanToken);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = cleanToken;

    return c.json(await getAuthStatus());
  });

  /**
   * Start the OAuth login flow by spawning `claude auth login`.
   *
   * @returns The OAuth URL the user should open in their browser
   */
  app.post("/oauth/start", async (c) => {
    try {
      const url = await spawnLoginProcess();
      return c.json({ url });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * Complete the OAuth login by sending the auth code to the CLI process.
   *
   * @returns Auth status after login attempt
   */
  app.post("/oauth/code", async (c) => {
    const { code } = await c.req.json<{ code: string }>();

    if (!code || typeof code !== "string") {
      return c.json({ error: "Code is required" }, 400);
    }

    const result = await sendCodeToLogin(code.trim());

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    // Verify auth status after successful login
    const status = await getAuthStatus();
    return c.json(status);
  });

  return app;
}
