/**
 * MCP servers status panel.
 *
 * Fetches the list of configured MCP servers on mount and renders each
 * as a row with status dot, name, URL, type badge, and status label.
 * Includes an "Add MCP Server" button that opens a modal with preloaded options.
 */

import { useState, useEffect, useCallback } from "react";
import { get, post, del } from "../api";
import { TwilioPanel } from "./TwilioPanel";
import { BrowserCallSetupPanel } from "./BrowserCallSetupPanel";
import { AddMcpServerModal } from "./AddMcpServerModal";
import { Toast } from "./Toast";
import type { ApiError } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
  scope: "project" | "user" | "local";
}

interface McpServersPanelProps {
  ngrokRunning: boolean;
  twilioRunning: boolean;
  browserCallRunning: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function McpServersPanel({ ngrokRunning, twilioRunning, browserCallRunning }: McpServersPanelProps) {
  const [servers, setServers] = useState<McpServerEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [showTwilioModal, setShowTwilioModal] = useState(false);
  const [showBrowserCallModal, setShowBrowserCallModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  /** Fetch the list of configured MCP servers */
  const fetchServers = useCallback(async () => {
    try {
      const data = await get<{ servers: McpServerEntry[] }>("/api/mcp-servers");
      setServers(data.servers);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);


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
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-header" style={{ borderBottom: "none", padding: 0, marginBottom: 24 }}>
        <div>
          <h1>Integrations & MCP</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Connect external services and configure MCP servers.</p>
        </div>
      </div>
      <div className="integrations-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Integrations</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>Connect external services like Twilio to enable voice calling capabilities.</p>

        <div style={{ display: "flex", gap: 12 }}>
          <span className="btn-integration" style={{ cursor: "default" }}>
            <span className={`integration-dot${ngrokRunning ? " running" : ""}`} />
            ngrok
          </span>
          <button className="btn-integration" onClick={() => setShowTwilioModal(true)}>
            <span className={`integration-dot${twilioRunning ? " running" : ""}`} />
            Twilio
          </button>
          <button className="btn-integration" onClick={() => setShowBrowserCallModal(true)}>
            <span className={`integration-dot${browserCallRunning ? " running" : ""}`} />
            Browser Call from Anywhere
          </button>
        </div>
      </div>

      <div className="mcp-panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>MCP Servers</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>Configure Model Context Protocol servers to provide external tools to Claude.</p>
          </div>
          <button className="mcp-add-btn" onClick={() => setShowAddModal(true)}>
            + Add MCP Server
          </button>
        </div>
        <div className="mcp-server-list">
          {!servers && !error && <div className="mcp-loading">Loading...</div>}
          {error && <div className="mcp-error">Failed to load MCP servers.</div>}
          {servers && servers.length === 0 && (
            <div className="mcp-loading" style={{ color: "var(--text-secondary)", fontSize: 13 }}>No MCP servers configured.</div>
          )}
          {servers?.map((server) => {
            const isGlobal = server.scope === "user";
            return (
              <div key={server.name} className="mcp-server-row">
                <span className={`mcp-dot ${dotClass(server.status)}`} />
                <span className="mcp-server-name">{server.name}</span>
                <span className="mcp-server-url" title={server.url}>{server.url}</span>
                <span className="mcp-server-badge">{server.type.toUpperCase()}</span>
                {server.status === "needs_auth" && server.type === "http" ? (
                  <button
                    className={`mcp-server-status ${dotClass(server.status)}`}
                    title="Opens Terminal to re-add this server and trigger login"
                    onClick={() => post(`/api/mcp-servers/${server.name}/auth`).catch(() => { })}
                  >
                    Authenticate
                  </button>
                ) : (
                  <span className={`mcp-server-status ${dotClass(server.status)}`}>
                    {statusLabel(server.status)}
                  </span>
                )}
                <span className="mcp-delete-wrap">
                  <button
                    className={`mcp-delete-btn${isGlobal ? " disabled" : ""}`}
                    onClick={() => {
                      if (!isGlobal) del(`/api/mcp-servers/${server.name}`).then(fetchServers).catch((err) => {
                      setToast((err as ApiError)?.message || "Failed to remove server");
                    });
                    }}
                  >
                    &times;
                  </button>
                  <span className="mcp-delete-tooltip">
                    {isGlobal ? "Globally installed, please delete through Claude Code" : `Remove ${server.name}`}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {showTwilioModal && (
        <TwilioPanel onClose={() => setShowTwilioModal(false)} />
      )}

      {showBrowserCallModal && (
        <BrowserCallSetupPanel onClose={() => setShowBrowserCallModal(false)} />
      )}

      {showAddModal && (
        <AddMcpServerModal
          servers={servers}
          onClose={() => setShowAddModal(false)}
          onAdded={fetchServers}
        />
      )}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
