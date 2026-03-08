/**
 * Tests that dashboard password protection (HTTP Basic Auth) works correctly.
 *
 * Uses Hono's in-memory app.request() -- no real HTTP server needed.
 *
 * Run: npx tsx --test dashboard/dashboard-auth.test.ts
 */

import { test, describe, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

import { createApp } from "./server.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const TEST_PASSWORD = "test-secret-123";
const TEST_ENDPOINT = "/api/status";

/**
 * Encode credentials as a Basic Auth header value.
 */
function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

// ============================================================================
// TESTS
// ============================================================================

describe("dashboard password protection", () => {
  beforeEach(() => {
    delete process.env.DASHBOARD_PASSWORD;
  });

  test("no password set -- requests succeed without credentials", async () => {
    const app = createApp();
    const res = await app.request(TEST_ENDPOINT);
    assert.equal(res.status, 200);
  });

  test("password set, no credentials -- returns 401", async () => {
    process.env.DASHBOARD_PASSWORD = TEST_PASSWORD;
    const app = createApp();
    const res = await app.request(TEST_ENDPOINT);
    assert.equal(res.status, 401);
  });

  test("password set, wrong credentials -- returns 401", async () => {
    process.env.DASHBOARD_PASSWORD = TEST_PASSWORD;
    const app = createApp();
    const res = await app.request(TEST_ENDPOINT, {
      headers: { Authorization: basicAuthHeader("admin", "wrong-password") },
    });
    assert.equal(res.status, 401);
  });

  test("password set, correct credentials -- returns 200", async () => {
    process.env.DASHBOARD_PASSWORD = TEST_PASSWORD;
    const app = createApp();
    const res = await app.request(TEST_ENDPOINT, {
      headers: { Authorization: basicAuthHeader("admin", TEST_PASSWORD) },
    });
    assert.equal(res.status, 200);
  });
});
