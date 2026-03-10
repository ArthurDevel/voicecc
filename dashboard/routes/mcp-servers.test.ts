/**
 * Tests for MCP server mapping logic.
 *
 * Verifies that SDK McpServerStatus objects are correctly transformed
 * into frontend McpServerEntry objects with proper scope, status, URL,
 * and type mapping.
 *
 * Run: npx tsx --test dashboard/routes/mcp-servers.test.ts
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { mapSdkStatusToEntry, mapScope, mapStatus, extractUrl, inferType } from "./mcp-servers.js";

// ============================================================================
// mapScope
// ============================================================================

describe("mapScope", () => {
  test("maps claudeai variants to 'claudeai'", () => {
    assert.equal(mapScope("claudeai"), "claudeai");
    assert.equal(mapScope("claude_ai"), "claudeai");
    assert.equal(mapScope("claude.ai"), "claudeai");
    assert.equal(mapScope("ClaudeAI"), "claudeai");
  });

  test("maps known scopes", () => {
    assert.equal(mapScope("managed"), "managed");
    assert.equal(mapScope("user"), "user");
    assert.equal(mapScope("project"), "project");
  });

  test("defaults to 'local' for undefined or unknown", () => {
    assert.equal(mapScope(undefined), "local");
    assert.equal(mapScope("something-else"), "local");
  });
});

// ============================================================================
// mapStatus
// ============================================================================

describe("mapStatus", () => {
  test("maps SDK statuses to frontend statuses", () => {
    assert.equal(mapStatus("connected"), "connected");
    assert.equal(mapStatus("needs-auth"), "needs_auth");
    assert.equal(mapStatus("pending"), "pending");
    assert.equal(mapStatus("disabled"), "disabled");
  });

  test("unknown status maps to 'failed'", () => {
    assert.equal(mapStatus("error"), "failed");
    assert.equal(mapStatus("unknown"), "failed");
  });
});

// ============================================================================
// extractUrl
// ============================================================================

describe("extractUrl", () => {
  test("extracts URL from http config", () => {
    const s = { name: "test", status: "connected" as const, config: { url: "https://example.com/mcp" } };
    assert.equal(extractUrl(s), "https://example.com/mcp");
  });

  test("extracts command + args from stdio config", () => {
    const s = { name: "test", status: "connected" as const, config: { command: "npx", args: ["my-server@latest"] } };
    assert.equal(extractUrl(s), "npx my-server@latest");
  });

  test("returns empty string when no config", () => {
    const s = { name: "test", status: "connected" as const };
    assert.equal(extractUrl(s), "");
  });

  test("returns empty string when config has no url or command", () => {
    const s = { name: "test", status: "connected" as const, config: {} };
    assert.equal(extractUrl(s), "");
  });
});

// ============================================================================
// inferType
// ============================================================================

describe("inferType", () => {
  test("stdio when config has command", () => {
    const s = { name: "test", status: "connected" as const, config: { command: "npx", args: ["server"] } };
    assert.equal(inferType(s, "npx server"), "stdio");
  });

  test("http when url starts with http", () => {
    const s = { name: "test", status: "connected" as const, config: { url: "https://example.com" } };
    assert.equal(inferType(s, "https://example.com"), "http");
  });

  test("defaults to stdio for unknown", () => {
    const s = { name: "test", status: "connected" as const };
    assert.equal(inferType(s, ""), "stdio");
  });
});

// ============================================================================
// mapSdkStatusToEntry (end-to-end mapping)
// ============================================================================

describe("mapSdkStatusToEntry", () => {
  test("maps a claude.ai HTTP server", () => {
    const entry = mapSdkStatusToEntry({
      name: "claude.ai Notion",
      status: "connected",
      scope: "claudeai",
      config: { url: "https://mcp.notion.com/mcp" },
    });

    assert.equal(entry.name, "claude.ai Notion");
    assert.equal(entry.scope, "claudeai");
    assert.equal(entry.status, "connected");
    assert.equal(entry.type, "http");
    assert.equal(entry.url, "https://mcp.notion.com/mcp");
  });

  test("maps a user-scoped stdio server", () => {
    const entry = mapSdkStatusToEntry({
      name: "chrome-devtools",
      status: "connected",
      scope: "user",
      config: { command: "npx", args: ["chrome-devtools-mcp@latest"] },
    });

    assert.equal(entry.scope, "user");
    assert.equal(entry.type, "stdio");
    assert.equal(entry.url, "npx chrome-devtools-mcp@latest");
  });

  test("maps needs-auth status with hyphen to underscore", () => {
    const entry = mapSdkStatusToEntry({
      name: "figmadrive",
      status: "needs-auth",
      scope: "project",
    });

    assert.equal(entry.status, "needs_auth");
    assert.equal(entry.scope, "project");
  });

  test("maps disabled server", () => {
    const entry = mapSdkStatusToEntry({
      name: "sentry",
      status: "disabled",
      scope: "user",
      config: { url: "https://mcp.sentry.dev/mcp" },
    });

    assert.equal(entry.status, "disabled");
    assert.equal(entry.type, "http");
  });

  test("handles server with no config or scope", () => {
    const entry = mapSdkStatusToEntry({
      name: "mystery",
      status: "failed",
    });

    assert.equal(entry.scope, "local");
    assert.equal(entry.status, "failed");
    assert.equal(entry.url, "");
    assert.equal(entry.type, "stdio");
  });
});
