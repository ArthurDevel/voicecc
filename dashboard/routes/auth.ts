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

/** Strip ANSI escape codes from PTY output. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[^m]*m/g, "");
}

/** Extract OAuth URL from (already stripped) PTY output. Returns null if not found. */
export function extractOAuthUrl(stripped: string): string | null {
  const match = stripped.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
  return match ? match[1] : null;
}

/** REPL indicators that signal the user is already authenticated. */
export const REPL_INDICATORS = [
  /\/effort/,             // effort command shown in REPL status
  /◐.*medium/,           // model indicator in REPL
  /\$\d+\.\d+/,           // cost like $0.00
  /what can i help/i,
];

/** Check if stripped PTY output contains REPL indicators. */
export function detectRepl(stripped: string): boolean {
  return REPL_INDICATORS.some((pattern) => pattern.test(stripped));
}

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
    let enterCount = 0;

    child.onData((data: string) => {
      output += data;
      const clean = stripAnsi(data).replace(/\r/g, "").trim();
      if (clean) console.debug(`[auth/login] data: ${clean.slice(0, 200)}`);

      if (resolved) return;

      const stripped = stripAnsi(output);

      // Check for OAuth URL (match against stripped output so ANSI codes
      // like \x1b[39m don't get appended to the URL)
      const url = extractOAuthUrl(stripped);
      if (url) {
        resolved = true;
        console.debug("[auth/login] URL captured");
        pendingLogin = {
          pty: child,
          url,
          createdAt: Date.now(),
        };
        resolve(url);
        return;
      }

      // Detect REPL prompt — means user is already authenticated.
      if (enterCount >= 1 && !resolved && detectRepl(stripped)) {
        resolved = true;
        console.debug("[auth/login] REPL detected — already authenticated");
        child.kill();
        reject(new Error("ALREADY_AUTHENTICATED"));
        return;
      }
    });

    // Press Enter every 2s to advance through setup prompts
    // (trust, theme, login method, etc.) until the OAuth URL appears.
    // Some prompts render ❯ via ANSI cursor positioning which is
    // impossible to detect reliably, so periodic Enter is simplest.
    const enterInterval = setInterval(() => {
      if (resolved) { clearInterval(enterInterval); return; }
      enterCount++;
      console.debug(`[auth/login] pressing Enter (periodic #${enterCount})`);
      child.write("\r");
    }, 2000);

    child.onExit(({ exitCode }: { exitCode: number }) => {
      clearInterval(enterInterval);
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
        clearInterval(enterInterval);
        resolved = true;
        child.kill();
        const clean = output.replace(/\x1b\[[^m]*m/g, "").slice(-500);
        reject(new Error(`Login timed out. Last output: ${clean}`));
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

  /** Log out of Claude Code. */
  app.post("/logout", async (c) => {
    return new Promise((resolve) => {
      execFile(CLAUDE_BIN, ["auth", "logout"], { timeout: PROBE_TIMEOUT_MS }, (_err, _stdout, _stderr) => {
        // Also clear any env token
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        getAuthStatus().then((status) => resolve(c.json(status)));
      });
    });
  });

  /**
   * Start the OAuth login flow.
   * Spawns interactive claude via PTY, navigates to /login, returns URL.
   */
  app.post("/oauth/start", async (c) => {
    // Pre-check: if already authenticated, don't spawn PTY
    const status = await getAuthStatus();
    if (status.authenticated) {
      return c.json({ error: "Already authenticated", alreadyAuthenticated: true }, 400);
    }

    try {
      const url = await spawnLoginProcess();
      return c.json({ url });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "ALREADY_AUTHENTICATED") {
        return c.json({ error: "Already authenticated", alreadyAuthenticated: true }, 400);
      }
      return c.json({ error: msg }, 500);
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
