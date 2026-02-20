/**
 * MCP servers status panel.
 *
 * Fetches the list of configured MCP servers on mount and renders each
 * as a row with status dot, name, URL, type badge, and status label.
 */

import { useState, useEffect } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
}

// ============================================================================
// COMPONENT
// ============================================================================

export function McpServersPanel() {
  const [servers, setServers] = useState<McpServerEntry[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    get<{ servers: McpServerEntry[] }>("/api/mcp-servers")
      .then((data) => setServers(data.servers))
      .catch(() => setError(true));
  }, []);

  /** Map server status to CSS class */
  const dotClass = (status: McpServerEntry["status"]): string => {
    if (status === "connected") return "connected";
    if (status === "needs_auth") return "needs-auth";
    return "failed";
  };

  /** Map server status to display label */
  const statusLabel = (status: McpServerEntry["status"]): string => {
    if (status === "connected") return "Connected";
    if (status === "needs_auth") return "Needs auth";
    return "Failed";
  };

  return (
    <div className="mcp-panel">
      <h2>MCP Servers</h2>
      <div className="mcp-server-list">
        {!servers && !error && <div className="mcp-loading">Loading...</div>}
        {error && <div className="mcp-error">Failed to load MCP servers.</div>}
        {servers && servers.length === 0 && (
          <div className="mcp-loading">No MCP servers configured.</div>
        )}
        {servers?.map((server) => (
          <div key={server.name} className="mcp-server-row">
            <span className={`mcp-dot ${dotClass(server.status)}`} />
            <span className="mcp-server-name">{server.name}</span>
            <span className="mcp-server-url" title={server.url}>{server.url}</span>
            <span className="mcp-server-badge">{server.type.toUpperCase()}</span>
            {server.status === "needs_auth" && server.type === "http" ? (
              <button
                className={`mcp-server-status ${dotClass(server.status)}`}
                title="Opens Terminal to re-add this server and trigger login"
                onClick={() => post(`/api/mcp-servers/${server.name}/auth`).catch(() => {})}
              >
                Authenticate
              </button>
            ) : (
              <span className={`mcp-server-status ${dotClass(server.status)}`}>
                {statusLabel(server.status)}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
