/**
 * Unit tests for WhatsApp message handler functions.
 *
 * Tests shouldHandleMessage filtering and collectSseResponse SSE parsing.
 *
 * Run: node --experimental-test-module-mocks --import tsx/esm --test server/services/whatsapp-message-handler.test.ts
 */

import { describe, it, mock, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { proto } from "baileys";

// ============================================================================
// MODULE MOCKS (must be set up before importing the module under test)
// ============================================================================

/** Tracks which groupJids are considered "mapped" to agents */
const mappedGroups: Map<string, string> = new Map();

mock.module("./whatsapp-manager.js", {
  namedExports: {
    getSocket: () => null,
  },
});

mock.module("./whatsapp-groups.js", {
  namedExports: {
    getAgentIdForGroup: (jid: string) => mappedGroups.get(jid),
    getLastSessionId: () => null,
    setLastSessionId: async () => {},
  },
});

const { shouldHandleMessage, collectSseResponse, normalizeJid } = await import(
  "./whatsapp-message-handler.js"
);

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a minimal Baileys IWebMessageInfo-like object for testing.
 *
 * @param overrides - Fields to override on the default message
 * @returns A fake Baileys message
 */
function buildMessage(overrides: {
  remoteJid?: string;
  participant?: string;
  fromMe?: boolean;
  text?: string | null;
  id?: string;
} = {}): proto.IWebMessageInfo {
  const {
    remoteJid = "120363001234567890@g.us",
    participant = "5511999998888@s.whatsapp.net",
    fromMe = false,
    text = "Hello agent",
    id = "msg-001",
  } = overrides;

  return {
    key: {
      remoteJid,
      participant,
      fromMe,
      id,
    },
    message: text !== null
      ? { conversation: text }
      : undefined,
  };
}

/**
 * Create a fake Response with an SSE body stream.
 *
 * @param sseEvents - Array of SSE event strings (each is a "data: {...}" line)
 * @param status - HTTP status code
 * @returns A Response-like object
 */
function buildSseResponse(sseEvents: string[], status = 200): Response {
  const sseText = sseEvents.map((e) => `data: ${e}\n\n`).join("");
  const encoder = new TextEncoder();
  const encoded = encoder.encode(sseText);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });

  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ============================================================================
// TESTS: shouldHandleMessage
// ============================================================================

describe("shouldHandleMessage", () => {
  const ownJid = "5511999991111@s.whatsapp.net";
  const mappedGroupJid = "120363001234567890@g.us";

  beforeEach(() => {
    mappedGroups.clear();
    mappedGroups.set(mappedGroupJid, "agent-1");
  });

  it("returns null for DMs (user JID, not a group)", () => {
    const msg = buildMessage({ remoteJid: "5511999998888@s.whatsapp.net" });
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns null for status broadcasts", () => {
    const msg = buildMessage({ remoteJid: "status@broadcast" });
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns null for messages from the bot itself (fromMe: true)", () => {
    const msg = buildMessage({
      remoteJid: mappedGroupJid,
      fromMe: true,
      participant: ownJid,
    });
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns null for messages in unmapped groups", () => {
    const unmappedGroupJid = "120363009999999999@g.us";
    const msg = buildMessage({ remoteJid: unmappedGroupJid });
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns null for non-text messages (no message content)", () => {
    const msg = buildMessage({ remoteJid: mappedGroupJid, text: null });
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns null when remoteJid is missing", () => {
    const msg = {
      key: { remoteJid: undefined, participant: "someone@s.whatsapp.net", fromMe: false },
      message: { conversation: "Hello" },
    };
    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });

  it("returns a WhatsAppIncomingMessage for valid text in a mapped group", () => {
    const msg = buildMessage({
      remoteJid: mappedGroupJid,
      participant: "5511999998888@s.whatsapp.net",
      text: "What is the weather?",
    });

    const result = shouldHandleMessage(msg, ownJid);
    assert.notEqual(result, null);
    assert.equal(result!.groupJid, mappedGroupJid);
    assert.equal(result!.senderJid, "5511999998888@s.whatsapp.net");
    assert.equal(result!.text, "What is the weather?");
    assert.equal(result!.messageId, "msg-001");
  });

  it("handles JID normalization -- ownJid with :0 device suffix", () => {
    const ownJidWithDevice = "5511999991111:0@s.whatsapp.net";
    // Sender JID matches ownJid after stripping the :0 suffix, but fromMe=false
    // so it should NOT be filtered as "bot itself". However, the sender and owner
    // have different numbers, so this message passes through.
    const msg = buildMessage({
      remoteJid: mappedGroupJid,
      participant: "5511999998888@s.whatsapp.net",
    });

    const result = shouldHandleMessage(msg, ownJidWithDevice);
    assert.notEqual(result, null);
    assert.equal(result!.groupJid, mappedGroupJid);
  });

  it("normalizeJid strips :0 device suffix correctly", () => {
    assert.equal(normalizeJid("5511999991111:0@s.whatsapp.net"), "5511999991111@s.whatsapp.net");
    assert.equal(normalizeJid("5511999991111:42@s.whatsapp.net"), "5511999991111@s.whatsapp.net");
    assert.equal(normalizeJid("5511999991111@s.whatsapp.net"), "5511999991111@s.whatsapp.net");
  });

  it("filters out messages where normalized sender matches normalized ownJid", () => {
    // Sender has :0 suffix, ownJid does not, but after normalization they match
    const msg = buildMessage({
      remoteJid: mappedGroupJid,
      participant: "5511999991111:0@s.whatsapp.net",
      fromMe: false,
    });

    const result = shouldHandleMessage(msg, ownJid);
    assert.equal(result, null);
  });
});

// ============================================================================
// TESTS: collectSseResponse
// ============================================================================

describe("collectSseResponse", () => {
  it("accumulates text_delta events and extracts session_id from result", async () => {
    const events = [
      JSON.stringify({ type: "text_delta", content: "Hello " }),
      JSON.stringify({ type: "text_delta", content: "world!" }),
      JSON.stringify({ type: "result", session_id: "sess-abc-123" }),
    ];

    const response = buildSseResponse(events);
    const result = await collectSseResponse(response);

    assert.equal(result.text, "Hello world!");
    assert.equal(result.sessionId, "sess-abc-123");
  });

  it("returns ALREADY_STREAMING for HTTP 409", async () => {
    const response = new Response("Already streaming", { status: 409 });
    const result = await collectSseResponse(response);

    assert.equal(result.text, "ALREADY_STREAMING");
    assert.equal(result.sessionId, null);
  });

  it("returns user-friendly error string for SSE error events", async () => {
    const events = [
      JSON.stringify({ type: "error", error: "Internal server error" }),
    ];

    const response = buildSseResponse(events);
    const result = await collectSseResponse(response);

    assert.equal(
      result.text,
      "Sorry, something went wrong while generating a response. Please try again."
    );
    assert.equal(result.sessionId, null);
  });

  it("returns empty string for an empty stream", async () => {
    const response = buildSseResponse([]);
    const result = await collectSseResponse(response);

    assert.equal(result.text, "");
    assert.equal(result.sessionId, null);
  });

  it("returns empty string when response body is null", async () => {
    // Construct a response with no body
    const response = new Response(null, { status: 200 });
    const result = await collectSseResponse(response);

    assert.equal(result.text, "");
    assert.equal(result.sessionId, null);
  });

  it("throws for non-2xx responses other than 409", async () => {
    const response = new Response("Server error", { status: 500 });

    await assert.rejects(
      () => collectSseResponse(response),
      (err: Error) => {
        assert.match(err.message, /HTTP 500/);
        return true;
      }
    );
  });

  it("handles result event without session_id", async () => {
    const events = [
      JSON.stringify({ type: "text_delta", content: "Some text" }),
      JSON.stringify({ type: "result" }),
    ];

    const response = buildSseResponse(events);
    const result = await collectSseResponse(response);

    assert.equal(result.text, "Some text");
    assert.equal(result.sessionId, null);
  });

  it("skips malformed JSON events gracefully", async () => {
    const sseText = [
      "data: {invalid json}\n\n",
      `data: ${JSON.stringify({ type: "text_delta", content: "valid" })}\n\n`,
      `data: ${JSON.stringify({ type: "result", session_id: "sess-1" })}\n\n`,
    ].join("");

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText));
        controller.close();
      },
    });

    const response = new Response(stream, { status: 200 });
    const result = await collectSseResponse(response);

    assert.equal(result.text, "valid");
    assert.equal(result.sessionId, "sess-1");
  });
});
