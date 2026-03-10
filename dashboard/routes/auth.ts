/**
 * Claude Code authentication routes.
 *
 * Handles auth status checks, manual token auth, and CLI OAuth login flow.
 * The OAuth flow spawns an interactive `claude` session via node-pty, sends
 * `/login`, selects "Claude Pro", and captures the OAuth URL. The user then
 * authenticates in their browser and pastes the code back.
 *
 * - GET /              -- probe auth status via `claude auth status`
 * - POST /token        -- save a manually pasted token to .env
 * - POST /oauth/start  -- spawn interactive claude, run /login, return OAuth URL
 * - POST /oauth/code   -- send the auth code to the PTY process
 */

import { Hono } from "hono";
import { execFile, execFileSync } from "child_process";
import pty, { type IPty } from "node-pty";
import { writeEnvKey } from "../../server/services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = "claude";
const PROBE_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

/** Auth status returned by `claude auth status`. */
interface AuthStatus {
  authenticated: boolean;
  authMethod: string;
  email?: string;
}

/** Tracks the running interactive claude PTY process. */
interface PendingLogin {
  pty: IPty;
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
 * Resolve the full path to the claude binary.
 */
function resolveClaudePath(): string {
  try {
    return execFileSync("which", [CLAUDE_BIN]).toString().trim();
  } catch {
    return CLAUDE_BIN;
  }
}

/**
 * Spawn an interactive `claude` session via PTY, navigate through the login
 * flow, and extract the OAuth URL.
 *
 * Steps:
 * 1. Accept the "trust this folder" prompt
 * 2. Send `/login`
 * 3. Select "Claude Pro" (option 1)
 * 4. Capture the OAuth URL
 *
 * @param onStep - Callback for progress updates (not used by HTTP, for future SSE)
 * @returns The OAuth URL to show the user
 */
function spawnLoginProcess(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Kill any existing login process
    if (pendingLogin) {
      pendingLogin.pty.kill();
      pendingLogin = null;
    }

    const claudePath = resolveClaudePath();
    console.debug("[auth/login] spawning PTY:", claudePath);

    const child = pty.spawn(claudePath, [], {
      name: "xterm-256color",
      cols: 2000,
      rows: 50,
    });

    let output = "";
    let resolved = false;
    let step = 0;

    let loginSent = false;
    let enterDebounce: ReturnType<typeof setTimeout> | null = null;

    child.onData((data: string) => {
      output += data;
      const clean = data.replace(/\x1b\[[^m]*m/g, "").replace(/\r/g, "").trim();
      if (clean) console.debug(`[auth/login] step=${step} loginSent=${loginSent} data: ${clean.slice(0, 200)}`);

      if (resolved) return;

      // ---- Always check for OAuth URL (can appear during setup or after /login) ----
      const urlMatch = output.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
      if (urlMatch) {
        resolved = true;
        step = 4;
        console.debug("[auth/login] URL captured");
        pendingLogin = {
          pty: child,
          url: urlMatch[1],
          createdAt: Date.now(),
        };
        resolve(urlMatch[1]);
        return;
      }

      // ---- Dismiss any selection prompt (❯) by pressing Enter ----
      // Handles: trust, theme picker, login method, or any other setup prompt.
      if (/❯/.test(data)) {
        if (enterDebounce) clearTimeout(enterDebounce);
        enterDebounce = setTimeout(() => {
          console.debug("[auth/login] pressing Enter on selection prompt");
          child.write("\r");
        }, 800);
      }

      // ---- Detect the main REPL prompt and send /login ----
      // Sparkle animation means we're in the main REPL, not setup.
      if (!loginSent && /[✻✽✶✢]/.test(data)) {
        loginSent = true;
        console.debug("[auth/login] main prompt ready, sending /login");
        setTimeout(() => child.write("/login\r"), 1000);
      }
    });

    child.onExit(({ exitCode }: { exitCode: number }) => {
      console.debug("[auth/login] PTY exited with code", exitCode);
      if (!resolved) {
        resolved = true;
        reject(new Error(`Login process exited (code ${exitCode}) before producing a URL.`));
      }
      if (pendingLogin?.pty === child) {
        pendingLogin = null;
      }
    });

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        const clean = output.replace(/\x1b\[[^m]*m/g, "").slice(-500);
        reject(new Error(`Login timed out at step ${step}. Last output: ${clean}`));
      }
    }, LOGIN_TIMEOUT_MS);
  });
}

/**
 * Send the auth code to the pending login PTY process.
 * Also handles the "Press Enter to continue" prompt that follows.
 */
function sendCodeToLogin(code: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!pendingLogin) {
      resolve({ success: false, error: "No pending login process. Start the login flow first." });
      return;
    }

    const child = pendingLogin.pty;
    pendingLogin = null;

    let output = "";
    let done = false;
    let sentEnter = false;

    child.onData((data: string) => {
      output += data;
      console.debug("[auth/login] after code:", data.replace(/\x1b\[[^m]*m/g, "").trim().slice(0, 200));

      // Handle "Press Enter to continue" prompt
      if (!sentEnter && /press enter/i.test(output)) {
        sentEnter = true;
        console.debug("[auth/login] detected 'Press Enter' prompt, sending Enter");
        setTimeout(() => child.write("\r"), 1000);
      }

      // Detect successful login
      if (!done && /logged in/i.test(output)) {
        done = true;
        console.debug("[auth/login] login successful");
        setTimeout(() => {
          child.kill();
          resolve({ success: true });
        }, 2000);
      }
    });

    child.onExit(() => {
      if (!done) {
        done = true;
        // Even if exit wasn't clean, check if login was successful
        if (/logged in/i.test(output)) {
          resolve({ success: true });
        } else {
          const clean = output.replace(/\x1b\[[^m]*m/g, "").slice(-300);
          resolve({ success: false, error: `Login process exited. Output: ${clean}` });
        }
      }
    });

    // Send the code
    console.debug("[auth/login] writing code to PTY");
    child.write(code + "\r");

    // Timeout
    setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        const clean = output.replace(/\x1b\[[^m]*m/g, "").slice(-300);
        resolve({ success: false, error: `Timed out after sending code. Output: ${clean}` });
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
   * Start the OAuth login flow.
   * Spawns interactive claude via PTY, navigates to /login, returns URL.
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
   * Complete the OAuth login by sending the auth code to the PTY process.
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

    const status = await getAuthStatus();
    return c.json(status);
  });

  return app;
}
