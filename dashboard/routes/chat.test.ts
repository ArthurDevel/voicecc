/**
 * Tests for chat proxy route -- verifies resumeSessionId forwarding.
 *
 * Run: npx tsx --test dashboard/routes/chat.test.ts
 */

import { test, describe, afterEach } from "node:test";
import { strict as assert } from "node:assert";

import { chatRoutes } from "./chat.js";

// ============================================================================
// HELPERS
// ============================================================================

const originalFetch = globalThis.fetch;

/** Restore global fetch after each test */
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Build a Hono Request to POST /send with the given JSON body.
 * Uses x-forwarded-for: 127.0.0.1 to bypass device token validation.
 *
 * @param body - JSON body to send
 * @returns Response from the Hono app
 */
async function postSend(body: Record<string, unknown>): Promise<Response> {
  const app = chatRoutes();
  const req = new Request("http://localhost/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "127.0.0.1",
    },
    body: JSON.stringify(body),
  });
  return app.request(req);
}

// ============================================================================
// TESTS
// ============================================================================

describe("POST /send - resumeSessionId forwarding", () => {
  test("forwards resumeSessionId as resume_session_id to Python", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      capturedBody = JSON.parse(bodyText);
      // Return a minimal SSE response so the handler succeeds
      return new Response("data: done\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    await postSend({
      token: "test-token",
      agentId: "agent-1",
      text: "hello",
      resumeSessionId: "ses_abc123",
    });

    assert.ok(capturedBody, "fetch should have been called");
    assert.equal(capturedBody!.resume_session_id, "ses_abc123");
    assert.equal(capturedBody!.session_key, "test-token");
    assert.equal(capturedBody!.text, "hello");
  });

  test("omits resume_session_id when resumeSessionId is absent", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      capturedBody = JSON.parse(bodyText);
      return new Response("data: done\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    await postSend({
      token: "test-token",
      text: "hello",
    });

    assert.ok(capturedBody, "fetch should have been called");
    assert.equal("resume_session_id" in capturedBody!, false, "resume_session_id should not be present");
  });
});
