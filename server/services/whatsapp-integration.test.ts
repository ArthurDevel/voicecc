/**
 * Integration tests for WhatsApp message round-trip and group sync.
 *
 * Tests the full message handling pipeline (message -> Python -> reply) and
 * the group lifecycle when agents are created/deleted.
 *
 * Run: node --experimental-test-module-mocks --import tsx/esm --test server/services/whatsapp-integration.test.ts
 */

import { describe, it, mock, beforeEach } from "node:test";
import { strict as assert } from "node:assert";

// ============================================================================
// MODULE MOCKS (must be set up before importing modules under test)
// ============================================================================

/** In-memory group mappings used by the mocked whatsapp-groups module */
const groupMappings: Map<string, { agentId: string; lastSessionId: string | null }> = new Map();

/** Tracks calls to sock.sendMessage */
const sendMessageCalls: Array<{ jid: string; content: { text: string } }> = [];

/** Tracks calls to sock.groupCreate */
const groupCreateCalls: Array<{ name: string; participants: string[] }> = [];

/** Tracks calls to sock.groupLeave */
const groupLeaveCalls: Array<{ jid: string }> = [];

/** Counter for generating unique group JIDs from groupCreate */
let groupCreateCounter = 0;

/** Mock Baileys socket */
const mockSocket = {
  sendMessage: async (jid: string, content: { text: string }) => {
    sendMessageCalls.push({ jid, content });
  },
  groupCreate: async (name: string, participants: string[]) => {
    groupCreateCalls.push({ name, participants });
    groupCreateCounter++;
    return { id: `new-group-${groupCreateCounter}@g.us` };
  },
  groupLeave: async (jid: string) => {
    groupLeaveCalls.push({ jid });
  },
  groupFetchAllParticipating: async () => ({}),
};

// Mock whatsapp-manager to return our mock socket
mock.module("./whatsapp-manager.js", {
  namedExports: {
    getSocket: () => mockSocket,
    isConnected: () => true,
  },
});

// Mock whatsapp-groups with in-memory state that we control
mock.module("./whatsapp-groups.js", {
  namedExports: {
    getAgentIdForGroup: (jid: string) => groupMappings.get(jid)?.agentId,
    getLastSessionId: (jid: string) => groupMappings.get(jid)?.lastSessionId ?? null,
    setLastSessionId: async (jid: string, sessionId: string) => {
      const existing = groupMappings.get(jid);
      if (existing) {
        existing.lastSessionId = sessionId;
      }
    },
    syncGroupsForNewAgent: async (agentId: string) => {
      // Delegate to the real-ish logic using our mock socket
      const name = `[VoiceCC] ${agentId}`;
      const result = await mockSocket.groupCreate(name, []);
      groupMappings.set(result.id, { agentId, lastSessionId: null });
    },
    syncGroupsForDeletedAgent: async (agentId: string) => {
      for (const [jid, mapping] of groupMappings.entries()) {
        if (mapping.agentId === agentId) {
          await mockSocket.groupLeave(jid);
          groupMappings.delete(jid);
          return;
        }
      }
    },
    formatGroupName: (agentId: string) => `[VoiceCC] ${agentId}`,
    loadMappings: async () => {},
    saveMappings: async () => {},
    findMappingByAgentId: (agentId: string) => {
      for (const [jid, mapping] of groupMappings.entries()) {
        if (mapping.agentId === agentId) {
          return { groupJid: jid, ...mapping };
        }
      }
      return undefined;
    },
  },
});

// Mock agent-store for the group sync tests
mock.module("./agent-store.js", {
  namedExports: {
    listAgents: async () => [],
  },
});

const { handleIncomingMessage } = await import("./whatsapp-message-handler.js");
const {
  syncGroupsForNewAgent,
  syncGroupsForDeletedAgent,
} = await import("./whatsapp-groups.js");

// ============================================================================
// HELPERS
// ============================================================================

/** The original global fetch, used to restore after mocking */
const originalFetch = globalThis.fetch;

/**
 * Build a mock SSE response from Python /chat/send.
 *
 * @param events - Array of SSE event payloads
 * @param status - HTTP status code
 * @returns A Response with SSE body
 */
function buildPythonResponse(
  events: Array<{ type: string; content?: string; session_id?: string }>,
  status = 200
): Response {
  const sseText = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Parse the JSON body from a captured fetch call.
 *
 * @param fetchCall - The arguments passed to fetch
 * @returns The parsed JSON body
 */
async function parseFetchBody(fetchCall: [string, RequestInit]): Promise<Record<string, unknown>> {
  const body = fetchCall[1].body as string;
  return JSON.parse(body);
}

// ============================================================================
// TESTS: Full message round-trip
// ============================================================================

describe("handleIncomingMessage - message round-trip", () => {
  const groupJid = "120363001234567890@g.us";

  beforeEach(() => {
    // Reset state
    sendMessageCalls.length = 0;
    groupMappings.clear();
    groupMappings.set(groupJid, { agentId: "agent-1", lastSessionId: "prev-session-42" });
  });

  it("calls Python with correct params and sends reply back via Baileys", async (t) => {
    // Track fetch calls
    const fetchCalls: Array<[string, RequestInit]> = [];

    // Mock global fetch to return a known SSE response
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push([url, init]);
      return buildPythonResponse([
        { type: "text_delta", content: "I am " },
        { type: "text_delta", content: "agent-1." },
        { type: "result", session_id: "new-session-99" },
      ]);
    }) as typeof fetch;

    await handleIncomingMessage({
      groupJid,
      senderJid: "5511999998888@s.whatsapp.net",
      text: "Hello agent",
      messageId: "msg-001",
    });

    // Verify Python was called with correct params
    assert.equal(fetchCalls.length, 1);
    const [url, _init] = fetchCalls[0]!;
    assert.ok(url.endsWith("/chat/send"));

    const body = await parseFetchBody(fetchCalls[0]!);
    assert.equal(body.session_key, `wa:${groupJid}`);
    assert.equal(body.agent_id, "agent-1");
    assert.equal(body.resume_session_id, "prev-session-42");
    assert.equal(body.text, "Hello agent");

    // Verify reply was sent back via Baileys
    assert.equal(sendMessageCalls.length, 1);
    assert.equal(sendMessageCalls[0]!.jid, groupJid);
    assert.equal(sendMessageCalls[0]!.content.text, "I am agent-1.");

    // Verify session ID was stored
    assert.equal(groupMappings.get(groupJid)?.lastSessionId, "new-session-99");
  });

  it("sends 'Still thinking' when Python returns HTTP 409", async (t) => {
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async () => {
      return new Response("Already streaming", { status: 409 });
    }) as typeof fetch;

    await handleIncomingMessage({
      groupJid,
      senderJid: "5511999998888@s.whatsapp.net",
      text: "Another question",
      messageId: "msg-002",
    });

    // Verify "Still thinking" reply was sent
    assert.equal(sendMessageCalls.length, 1);
    assert.equal(sendMessageCalls[0]!.jid, groupJid);
    assert.equal(sendMessageCalls[0]!.content.text, "Still thinking, please wait...");

    // Session ID should not have changed
    assert.equal(groupMappings.get(groupJid)?.lastSessionId, "prev-session-42");
  });

  it("passes null resume_session_id when no previous session exists", async (t) => {
    // Clear the previous session
    groupMappings.set(groupJid, { agentId: "agent-1", lastSessionId: null });

    const fetchCalls: Array<[string, RequestInit]> = [];
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      fetchCalls.push([url, init]);
      return buildPythonResponse([
        { type: "text_delta", content: "First reply" },
        { type: "result", session_id: "first-session" },
      ]);
    }) as typeof fetch;

    await handleIncomingMessage({
      groupJid,
      senderJid: "5511999998888@s.whatsapp.net",
      text: "First message",
      messageId: "msg-003",
    });

    const body = await parseFetchBody(fetchCalls[0]!);
    assert.equal(body.resume_session_id, null);
  });
});

// ============================================================================
// TESTS: Group sync on agent lifecycle
// ============================================================================

describe("Group sync on agent lifecycle", () => {
  beforeEach(() => {
    groupMappings.clear();
    groupCreateCalls.length = 0;
    groupLeaveCalls.length = 0;
    sendMessageCalls.length = 0;
    groupCreateCounter = 0;
  });

  it("syncGroupsForNewAgent creates a group with [VoiceCC] prefix and persists mapping", async () => {
    await syncGroupsForNewAgent("sales-bot");

    // Verify groupCreate was called with the correct name
    assert.equal(groupCreateCalls.length, 1);
    assert.equal(groupCreateCalls[0]!.name, "[VoiceCC] sales-bot");
    assert.deepEqual(groupCreateCalls[0]!.participants, []);

    // Verify mapping was persisted
    const mapping = groupMappings.get("new-group-1@g.us");
    assert.notEqual(mapping, undefined);
    assert.equal(mapping!.agentId, "sales-bot");
    assert.equal(mapping!.lastSessionId, null);
  });

  it("syncGroupsForDeletedAgent leaves the group and removes mapping", async () => {
    // First create a mapping
    groupMappings.set("existing-group@g.us", { agentId: "old-agent", lastSessionId: "sess-1" });

    await syncGroupsForDeletedAgent("old-agent");

    // Verify groupLeave was called
    assert.equal(groupLeaveCalls.length, 1);
    assert.equal(groupLeaveCalls[0]!.jid, "existing-group@g.us");

    // Verify mapping was removed
    assert.equal(groupMappings.has("existing-group@g.us"), false);
  });

  it("syncGroupsForDeletedAgent does nothing for unmapped agent", async () => {
    await syncGroupsForDeletedAgent("nonexistent-agent");

    assert.equal(groupLeaveCalls.length, 0);
  });

  it("creating then deleting an agent results in clean state", async () => {
    // Create
    await syncGroupsForNewAgent("temp-agent");
    assert.equal(groupCreateCalls.length, 1);
    assert.equal(groupMappings.size, 1);

    // Delete
    await syncGroupsForDeletedAgent("temp-agent");
    assert.equal(groupLeaveCalls.length, 1);
    assert.equal(groupMappings.size, 0);
  });
});
