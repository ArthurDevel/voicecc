/**
 * Tests that the OAuth PKCE flow includes and validates the state parameter.
 *
 * Verifies:
 * - /oauth/start returns a state value and includes it in the URL
 * - /oauth/callback rejects requests with missing or wrong state
 * - /oauth/callback accepts requests with the correct state
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
    // Start a flow first so pendingPkce is set
    await postJson("/api/auth/oauth/start");

    const { status, data } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
    });

    assert.equal(status, 400);
    assert.ok(data.error.toLowerCase().includes("state"), "error should mention state");
  });

  test("/oauth/callback rejects wrong state", async () => {
    // Start a flow first so pendingPkce is set
    await postJson("/api/auth/oauth/start");

    const { status, data } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
      state: "wrong-state-value",
    });

    assert.equal(status, 400);
    assert.ok(data.error.toLowerCase().includes("state"), "error should mention state");
  });

  test("/oauth/callback accepts correct state", async () => {
    const startRes = await postJson<{ url: string; state: string }>("/api/auth/oauth/start");

    // The token exchange will fail (fake code) but the state check should pass.
    // We expect a 500 from the token exchange, not a 400 from state validation.
    const { status } = await postJson<{ error: string }>("/api/auth/oauth/callback", {
      code: "fake-auth-code",
      state: startRes.data.state,
    });

    assert.equal(status, 500, "should pass state check and fail on token exchange (500), not state validation (400)");
  });
});
