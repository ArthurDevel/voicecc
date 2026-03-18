/**
 * Tests for MCP server SDK-to-frontend mapping.
 *
 * Run: npx tsx --test dashboard/routes/mcp-servers.test.ts
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { mapSdkStatusToEntry } from "./mcp-servers.js";

// ============================================================================
// TESTS
// ============================================================================

describe("mapSdkStatusToEntry", () => {
  test("claude.ai HTTP server maps correctly", () => {
    const entry = mapSdkStatusToEntry({
      name: "claude.ai Notion",
      status: "connected",
      scope: "claudeai",
      config: { url: "https://mcp.notion.com/mcp" } as McpServerStatus["config"],
    });

    assert.deepEqual(entry, {
      name: "claude.ai Notion",
      scope: "claudeai",
      status: "connected",
      type: "http",
      url: "https://mcp.notion.com/mcp",
    });
  });

  test("user-scoped stdio server maps correctly", () => {
    const entry = mapSdkStatusToEntry({
      name: "chrome-devtools",
      status: "connected",
      scope: "user",
      config: { command: "npx", args: ["chrome-devtools-mcp@latest"] } as McpServerStatus["config"],
    });

    assert.equal(entry.scope, "user");
    assert.equal(entry.type, "stdio");
    assert.equal(entry.url, "npx chrome-devtools-mcp@latest");
  });

  test("needs-auth hyphen becomes underscore for frontend", () => {
    const entry = mapSdkStatusToEntry({
      name: "figmadrive",
      status: "needs-auth",
      scope: "project",
    });

    assert.equal(entry.status, "needs_auth");
  });

  test("server with no config or scope gets safe defaults", () => {
    const entry = mapSdkStatusToEntry({
      name: "mystery",
      status: "failed",
    });

    assert.equal(entry.scope, "local");
    assert.equal(entry.url, "");
    assert.equal(entry.type, "stdio");
  });
});
