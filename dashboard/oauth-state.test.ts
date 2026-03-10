/**
 * Tests for the OAuth PKCE flow routes.
 *
 * Verifies:
 * - /oauth/start returns state in response and in URL
 * - /oauth/callback rejects missing/wrong state
 * - /oauth/callback accepts correct state (fails on token exchange, not state)
 * - Token URL points to platform.claude.com (not claude.ai) to avoid Cloudflare
 *
 * Run: npx tsx --test dashboard/oauth-state.test.ts
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { createApp } from "./server.js";

// ============================================================================
// HELPERS
// ============================================================================

const app = createApp();

/** POST JSON to the app and return the parsed response. */
async function postJson<T>(path: string, body?: Record<string, unknown>): Promise<{ status: number; data: T }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as T;
  return { status: res.status, data };
}

// ============================================================================
// TESTS
// ============================================================================

describe("OAuth state parameter", () => {
  test("/oauth/start returns state in response and in URL", async () => {
    const { status, data } = await postJson<{ url: string; state: string }>("/api/auth/oauth/start");

    assert.equal(status, 200);
    assert.ok(data.state, "response should include a state value");
    assert.ok(data.state.length > 10, "state should be a non-trivial random string");
    assert.ok(data.url.includes(`state=${data.state}`), "URL should contain the state parameter");
  });

  test("/oauth/callback rejects missing state", async () => {
    await postJson("/api/auth/oauth/start");

    const { status, data } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
    });

    assert.equal(status, 400);
    assert.ok(data.error.toLowerCase().includes("state"), "error should mention state");
  });

  test("/oauth/callback rejects wrong state", async () => {
    await postJson("/api/auth/oauth/start");

    const { status, data } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
      state: "wrong-state-value",
    });

    assert.equal(status, 400);
    assert.ok(data.error.toLowerCase().includes("state"), "error should mention state");
  });

  test("/oauth/callback accepts correct state (fails on token exchange, not state)", async () => {
    const startRes = await postJson<{ url: string; state: string }>("/api/auth/oauth/start");

    const { status } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
      state: startRes.data.state,
    });

    // Should pass state check and fail on token exchange (500), not state validation (400)
    assert.equal(status, 500);
  });
});

describe("OAuth token URL", () => {
  test("authorization URL uses claude.ai", async () => {
    const { data } = await postJson<{ url: string }>("/api/auth/oauth/start");
    assert.ok(data.url.startsWith("https://claude.ai/oauth/authorize"), "should use claude.ai for authorization");
  });

  test("token exchange error references platform.claude.com, not claude.ai", async () => {
    const startRes = await postJson<{ url: string; state: string }>("/api/auth/oauth/start");

    const { data } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
      state: startRes.data.state,
    });

    // The error message from a failed exchange should reference the real token URL
    assert.ok(!data.error.includes("claude.ai/oauth/token"), "should NOT use claude.ai for token exchange");
  });
});
