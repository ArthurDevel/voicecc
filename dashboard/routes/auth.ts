/**
 * Claude Code authentication routes.
 *
 * Supports two auth flows:
 * 1. OAuth PKCE flow via claude.ai (recommended -- enables cloud MCP servers)
 * 2. Manual token paste via `claude setup-token` (fallback)
 *
 * - GET /              -- probe auth status
 * - POST /token        -- save a manually pasted token
 * - POST /oauth/start  -- generate PKCE params and return the OAuth URL
 * - POST /oauth/callback -- exchange an auth code for tokens
 */

import { Hono } from "hono";
import { execFile } from "child_process";
import { randomBytes, createHash } from "crypto";
import { writeEnvKey } from "../../server/services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_BIN = "claude";
const PROBE_TIMEOUT_MS = 5_000;

const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_AUTH_URL = "https://claude.ai/oauth/authorize";
const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const OAUTH_SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";

// ============================================================================
// PKCE STATE (single-user dashboard -- one pending flow at a time)
// ============================================================================

let pendingPkce: { codeVerifier: string; state: string; createdAt: number } | null = null;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/** Base64url-encode a buffer (no padding). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Generate a PKCE code_verifier and code_challenge (S256). */
function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());
  return { codeVerifier, codeChallenge };
}

/**
 * Exchange an authorization code for tokens using the PKCE verifier.
 * @param code - The authorization code from the OAuth callback
 * @param codeVerifier - The PKCE code_verifier generated at flow start
 * @param state - The OAuth state parameter (required by the token endpoint)
 * @returns Token response with access_token, refresh_token, expires_in
 */
async function exchangeCodeForTokens(code: string, codeVerifier: string, state: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state,
      code_verifier: codeVerifier,
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

/** Auth status returned by `claude auth status`. */
interface AuthStatus {
  authenticated: boolean;
  /** "claude.ai" = OAuth (cloud MCPs available), "api-key" | "setup-token" = token only, "none" = not logged in */
  authMethod: string;
  email?: string;
}

/**
 * Get auth status via `claude auth status` JSON output.
 * Tries stdout first, then stderr (some versions output there on non-zero exit).
 * Falls back to unauthenticated if parsing fails entirely.
 */
async function getAuthStatus(): Promise<AuthStatus> {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ["auth", "status"], { timeout: PROBE_TIMEOUT_MS }, (err, stdout, stderr) => {
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

  /** Start an OAuth PKCE flow -- returns the authorization URL. */
  app.post("/oauth/start", async (c) => {
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = base64url(randomBytes(32));
    pendingPkce = { codeVerifier, state, createdAt: Date.now() };

    const params = new URLSearchParams({
      code: "true",
      client_id: OAUTH_CLIENT_ID,
      response_type: "code",
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    return c.json({ url: `${OAUTH_AUTH_URL}?${params.toString()}`, state });
  });

  /** Exchange an authorization code for tokens and save credentials. */
  app.post("/oauth/callback", async (c) => {
    const { code, state } = await c.req.json<{ code: string; state: string }>();

    if (!code || typeof code !== "string") {
      return c.json({ error: "Authorization code is required" }, 400);
    }

    if (!pendingPkce) {
      return c.json({ error: "No pending OAuth flow. Please start the login again." }, 400);
    }

    if (!state || state !== pendingPkce.state) {
      pendingPkce = null;
      return c.json({ error: "Invalid OAuth state. Please start the login again." }, 400);
    }

    // Expire stale flows (10 minutes)
    if (Date.now() - pendingPkce.createdAt > 10 * 60 * 1000) {
      pendingPkce = null;
      return c.json({ error: "OAuth flow expired. Please start the login again." }, 400);
    }

    try {
      const tokens = await exchangeCodeForTokens(code.trim(), pendingPkce.codeVerifier, pendingPkce.state);
      pendingPkce = null;

      const scopes = tokens.scope
        ? tokens.scope.split(" ")
        : OAUTH_SCOPES.split(" ");

      const credentialJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scopes,
        },
      });

      await writeEnvKey("CLAUDE_CODE_OAUTH_TOKEN", credentialJson);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = credentialJson;

      return c.json(await getAuthStatus());
    } catch (err) {
      console.error("[auth] OAuth token exchange error:", err);
      const message = err instanceof Error ? err.message : "Token exchange failed";
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
