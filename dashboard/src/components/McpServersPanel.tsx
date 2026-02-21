/**
 * MCP servers status panel.
 *
 * Fetches the list of configured MCP servers on mount and renders each
 * as a row with status dot, name, URL, type badge, and status label.
 */

import { useState, useEffect } from "react";
import { get, post } from "../api";
import { TwilioPanel } from "./TwilioPanel";

// ============================================================================
// TYPES
// ============================================================================

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
}

interface McpServersPanelProps {
  ngrokRunning: boolean;
  twilioRunning: boolean;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function McpServersPanel({ ngrokRunning, twilioRunning }: McpServersPanelProps) {
  const [servers, setServers] = useState<McpServerEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [modalMode, setModalMode] = useState<"twilio" | "webrtc" | null>(null);

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
    <div style={{ display: "flex", flexDirection: "column", gap: 32, paddingBottom: 32 }}>
      <div className="integrations-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Integrations</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>Connect external services like Twilio and WebRTC to enable voice calling capabilities.</p>

        <div style={{ display: "flex", gap: 12 }}>
          <span className="btn-integration" style={{ cursor: "default" }}>
            <span className={`integration-dot${ngrokRunning ? " running" : ""}`} />
            ngrok
          </span>
          <button className="btn-integration" onClick={() => setModalMode("twilio")}>
            <span className={`integration-dot${twilioRunning ? " running" : ""}`} />
            Twilio
          </button>
          <button className="btn-integration" onClick={() => setModalMode("webrtc")}>
            <span className={`integration-dot${twilioRunning ? " running" : ""}`} />
            WebRTC
          </button>
        </div>
      </div>

      <div className="mcp-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>MCP Servers</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>Configure Model Context Protocol servers to provide external tools to Claude.</p>
        <div className="mcp-server-list">
          {!servers && !error && <div className="mcp-loading">Loading...</div>}
          {error && <div className="mcp-error">Failed to load MCP servers.</div>}
          {servers && servers.length === 0 && (
            <div className="mcp-loading" style={{ color: "var(--text-secondary)", fontSize: 13 }}>No MCP servers configured.</div>
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
                  onClick={() => post(`/api/mcp-servers/${server.name}/auth`).catch(() => { })}
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

      {modalMode && (
        <TwilioPanel mode={modalMode} onClose={() => setModalMode(null)} />
      )}
    </div>
  );
}
