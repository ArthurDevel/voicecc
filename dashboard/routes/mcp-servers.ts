/**
 * MCP servers list API route.
 *
 * Uses the Claude Agent SDK to query MCP server status, which includes
 * both locally configured servers and claude.ai managed servers.
 * - GET /        -- list all MCP servers with connection status and scope
 * - POST /add    -- add a new MCP server via `claude mcp add`
 * - DELETE /:name -- remove an MCP server via `claude mcp remove`
 */

import { Hono } from "hono";
import { execFile } from "child_process";
import { query as claudeQuery, type McpServerStatus, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

// ============================================================================
// TYPES
// ============================================================================

/** MCP server entry returned to the frontend */
export interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth" | "pending" | "disabled";
  scope: "project" | "user" | "local" | "claudeai" | "managed";
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for MCP server operations.
 *
 * @returns Hono instance with MCP server routes
 */
export function mcpServersRoutes(): Hono {
  const app = new Hono();

  /** List all MCP servers using the SDK's mcpServerStatus() */
  app.get("/", async (c) => {
    try {
      const servers = await fetchMcpServersViaSdk();
      return c.json({ servers });
    } catch (err) {
      console.error("[mcp-servers] SDK query failed:", err);
      return c.json({ error: "Failed to fetch MCP servers", servers: [] }, 500);
    }
  });

  /** Add a new MCP server by running `claude mcp add` directly */
  app.post("/add", async (c) => {
    const { name, url, transport, scope } = await c.req.json<{
      name: string;
      url: string;
      transport: string;
      scope: string;
    }>();

    const args = ["mcp", "add", "--transport", transport, "--scope", scope, name, url];

    return new Promise<Response>((resolve) => {
      execFile("claude", args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("[mcp-servers] add error:", err.message);
          console.error("[mcp-servers] stderr:", stderr);
          resolve(c.json({ error: stderr || err.message }, 500));
          return;
        }
        resolve(c.json({ success: true, output: stdout }));
      });
    });
  });

  /** Remove an MCP server by running `claude mcp remove` */
  app.delete("/:name", async (c) => {
    const { name } = c.req.param();
    const args = ["mcp", "remove", name];

    return new Promise<Response>((resolve) => {
      execFile("claude", args, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("[mcp-servers] remove error:", err.message);
          resolve(c.json({ error: stderr || err.message }, 500));
          return;
        }
        resolve(c.json({ success: true, output: stdout }));
      });
    });
  });

  return app;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Simple async iterable that keeps the SDK process alive.
 * We push a single user message to trigger the first turn, then
 * call mcpServerStatus() while the process is still running.
 */
class SimpleQueue implements AsyncIterable<SDKUserMessage> {
  private resolve: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private buf: SDKUserMessage[] = [];
  private done = false;

  push(item: SDKUserMessage) {
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
  }

  close() {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.buf.length > 0) {
          return Promise.resolve({ value: this.buf.shift()!, done: false as const });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true as const });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((r) => { this.resolve = r; });
      },
    };
  }
}

/**
 * Spin up a minimal SDK session, call mcpServerStatus(), then tear it down.
 * This returns all MCP servers including claude.ai managed ones.
 *
 * Uses an AsyncQueue prompt so the SDK process stays alive after the first
 * turn completes, allowing mcpServerStatus() to communicate with it.
 *
 * @returns Array of MCP server entries
 */
async function fetchMcpServersViaSdk(): Promise<McpServerEntry[]> {
  const abortController = new AbortController();
  const userMessages = new SimpleQueue();

  const q = claudeQuery({
    prompt: userMessages,
    options: {
      maxTurns: 1,
      abortController,
      permissionMode: "default",
      cwd: process.cwd(),
      settingSources: ["user", "project", "local"],
      stderr: (data: string) => {
        const msg = data.trim();
        if (msg) console.error(`[mcp-servers-sdk-stderr] ${msg}`);
      },
    },
  });

  // Push a minimal user message to trigger the first turn
  userMessages.push({
    type: "user",
    message: { content: "ok", role: "user" },
    parent_tool_use_id: null,
    session_id: "",
  });

  // Consume the entire first turn — system event, assistant messages, and result.
  // MCP servers connect in the background during this time.
  for await (const msg of q) {
    if (msg.type === "system" && (msg as any).subtype === "init") {
      console.log(`[mcp-servers] SDK session init, mcp_servers in init:`, (msg as any).mcp_servers?.length ?? 0);
    }
    if (msg.type === "result") {
      console.log(`[mcp-servers] SDK first turn complete`);
      break;
    }
  }

  // Process is still alive because the AsyncQueue hasn't been closed.
  // Now we can query MCP server status.
  const statuses = await q.mcpServerStatus();
  console.log(`[mcp-servers] mcpServerStatus returned ${statuses.length} servers`);

  // Clean up: close the queue and abort the session
  userMessages.close();
  abortController.abort();

  return statuses.map(mapSdkStatusToEntry);
}

/**
 * Map an SDK McpServerStatus to our frontend McpServerEntry.
 *
 * @param s - SDK MCP server status object
 * @returns Mapped McpServerEntry for the frontend
 */
export function mapSdkStatusToEntry(s: McpServerStatus): McpServerEntry {
  const scope = mapScope(s.scope);
  const url = extractUrl(s);
  const type = inferType(s, url);
  const status = mapStatus(s.status);

  return { name: s.name, url, type, status, scope };
}

/**
 * Map SDK scope string to our scope type.
 *
 * @param sdkScope - Scope string from the SDK (e.g. "claudeai", "user", "project")
 * @returns Normalized scope value
 */
export function mapScope(sdkScope: string | undefined): McpServerEntry["scope"] {
  if (!sdkScope) return "local";
  const s = sdkScope.toLowerCase();
  if (s === "claudeai" || s === "claude_ai" || s === "claude.ai") return "claudeai";
  if (s === "managed") return "managed";
  if (s === "user") return "user";
  if (s === "project") return "project";
  return "local";
}

/**
 * Map SDK status string to our status type.
 *
 * @param sdkStatus - Status string from the SDK
 * @returns Normalized status value
 */
export function mapStatus(sdkStatus: string): McpServerEntry["status"] {
  if (sdkStatus === "connected") return "connected";
  if (sdkStatus === "needs-auth") return "needs_auth";
  if (sdkStatus === "pending") return "pending";
  if (sdkStatus === "disabled") return "disabled";
  return "failed";
}

/**
 * Extract URL or command from the SDK server config.
 *
 * @param s - SDK MCP server status
 * @returns URL string or command string
 */
export function extractUrl(s: McpServerStatus): string {
  const config = s.config as Record<string, unknown> | undefined;
  if (!config) return "";
  if (typeof config.url === "string") return config.url;
  if (typeof config.command === "string") {
    const args = Array.isArray(config.args) ? ` ${config.args.join(" ")}` : "";
    return `${config.command}${args}`;
  }
  return "";
}

/**
 * Infer transport type from server config.
 *
 * @param s - SDK MCP server status
 * @param url - Extracted URL string
 * @returns "http" or "stdio"
 */
export function inferType(s: McpServerStatus, url: string): "http" | "stdio" {
  const config = s.config as Record<string, unknown> | undefined;
  if (config && typeof config.command === "string") return "stdio";
  if (url.startsWith("http")) return "http";
  return "stdio";
}
