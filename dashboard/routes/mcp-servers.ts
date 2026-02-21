/**
 * MCP servers list API route.
 *
 * Runs `claude mcp list` and parses the output into structured entries:
 * - GET /        -- list all configured MCP servers with connection status
 * - POST /add    -- add a new MCP server by running `claude mcp add` directly
 * - POST /:name/auth -- open Terminal to guide user through MCP server auth
 */

import { Hono } from "hono";
import { execFile } from "child_process";
import { homedir } from "os";
import { join } from "path";

// ============================================================================
// TYPES
// ============================================================================

/** Parsed MCP server entry */
interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
  scope: "project" | "user" | "local";
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for MCP server operations.
 *
 * @returns Hono instance with GET / route
 */
export function mcpServersRoutes(): Hono {
  const app = new Hono();

  /** List MCP servers from Claude CLI, including scope from `mcp get` */
  app.get("/", async (c) => {
    const claudePath = join(homedir(), ".local", "bin", "claude");
    const output = await new Promise<string>((resolve) => {
      execFile(claudePath, ["mcp", "list"], { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("[mcp-servers] execFile error:", err.message);
          console.error("[mcp-servers] stderr:", stderr);
          resolve(stderr || err.message);
          return;
        }
        resolve(stdout);
      });
    });

    const servers = parseMcpListOutput(output);

    // Fetch scope for each server in parallel via `claude mcp get <name>`
    await Promise.all(
      servers.map((server) =>
        new Promise<void>((resolve) => {
          execFile(claudePath, ["mcp", "get", server.name], { timeout: 10000 }, (err, stdout) => {
            if (!err && stdout) {
              server.scope = parseScopeFromGet(stdout);
            }
            resolve();
          });
        })
      )
    );

    return c.json({ servers });
  });

  /** Add a new MCP server by running `claude mcp add` directly */
  app.post("/add", async (c) => {
    const { name, url, transport, scope } = await c.req.json<{
      name: string;
      url: string;
      transport: string;
      scope: string;
    }>();

    const claudePath = join(homedir(), ".local", "bin", "claude");
    const args = ["mcp", "add", "--transport", transport, "--scope", scope, name, url];

    return new Promise((resolve) => {
      execFile(claudePath, args, { timeout: 15000 }, (err, stdout, stderr) => {
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

  /** Open Claude Code in Terminal to guide user through MCP server auth */
  app.post("/:name/auth", async (c) => {
    const { name } = c.req.param();
    const claudePath = join(homedir(), ".local", "bin", "claude");

    const prompt = `Please guide the user through authenticating the ${name} MCP server. Tell them to type /mcp. Be to the point, concise, use bullet points and bold.`;
    // Escape double quotes for AppleScript string
    const escapedPrompt = prompt.replace(/"/g, '\\"');
    const script = `tell application "Terminal"
  activate
  do script "${claudePath} \\"${escapedPrompt}\\""
end tell`;

    return new Promise((resolve) => {
      execFile("osascript", ["-e", script], (err) => {
        if (err) {
          resolve(c.json({ error: err.message }, 500));
          return;
        }
        resolve(c.json({ success: true }));
      });
    });
  });

  /** Remove an MCP server by running `claude mcp remove` */
  app.delete("/:name", async (c) => {
    const { name } = c.req.param();
    const claudePath = join(homedir(), ".local", "bin", "claude");
    const args = ["mcp", "remove", name];

    return new Promise((resolve) => {
      execFile(claudePath, args, { timeout: 15000 }, (err, stdout, stderr) => {
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
 * Parse the text output of `claude mcp list` into structured entries.
 * Each line has the format: `<name>: <url-or-command> - <icon> <status>`
 *
 * @param output - Raw CLI output
 * @returns Array of parsed MCP server entries
 */
function parseMcpListOutput(output: string): McpServerEntry[] {
  const servers: McpServerEntry[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const match = line.match(/^(\S+): (.+?) - (?:\u2713|\u2717|\u26A0)\s*(.+)$/);
    if (!match) continue;

    const name = match[1];
    let urlOrCommand = match[2].trim();
    const statusText = match[3].trim().toLowerCase();

    const isHttp = urlOrCommand.includes("(HTTP)");
    const type: "http" | "stdio" = isHttp ? "http" : "stdio";
    urlOrCommand = urlOrCommand.replace(/\s*\(HTTP\)\s*$/, "").trim();

    let status: McpServerEntry["status"] = "failed";
    if (statusText.includes("connected")) {
      status = "connected";
    } else if (statusText.includes("auth")) {
      status = "needs_auth";
    }

    servers.push({ name, url: urlOrCommand, type, status, scope: "local" });
  }

  return servers;
}

/**
 * Parse the scope from `claude mcp get <name>` output.
 * Looks for "Scope: ..." line and maps to our scope type.
 *
 * @param output - Raw CLI output from `claude mcp get`
 * @returns Parsed scope
 */
function parseScopeFromGet(output: string): McpServerEntry["scope"] {
  const match = output.match(/Scope:\s*(.+)/i);
  if (!match) return "local";
  const scopeText = match[1].toLowerCase();
  if (scopeText.includes("user")) return "user";
  if (scopeText.includes("project")) return "project";
  return "local";
}
