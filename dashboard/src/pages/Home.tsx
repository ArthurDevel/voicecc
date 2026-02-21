/**
 * Main dashboard layout page.
 *
 * Manages active page state (settings vs conversation) and renders:
 * - Sidebar with navigation and conversation list
 * - Content area with either settings panels or conversation viewer
 */

import { useState, useCallback, useEffect } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { get, post } from "../api";
import type { LayoutContext } from "../components/Layout";

// ============================================================================
// TYPES
// ============================================================================

export interface TunnelStatus {
  running: boolean;
  url: string | null;
}

export interface TwilioStatus {
  running: boolean;
  tunnelUrl: string | null;
}

export interface BrowserCallStatus {
  running: boolean;
  tunnelUrl: string | null;
}

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
  scope: "project" | "user" | "local";
}

export function Home() {
  const { authStatus } = useOutletContext<LayoutContext>();
  const [loginDisabled, setLoginDisabled] = useState(false);
  const [browserCallRunning, setBrowserCallRunning] = useState<boolean | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[] | null>(null);

  useEffect(() => {
    get<BrowserCallStatus>("/api/browser-call/status")
      .then((data) => setBrowserCallRunning(data.running))
      .catch(() => setBrowserCallRunning(false));

    get<{ servers: McpServerEntry[] }>("/api/mcp-servers")
      .then((data) => setMcpServers(data.servers))
      .catch(() => setMcpServers([]));
  }, []);

  const handleLogin = useCallback(async () => {
    setLoginDisabled(true);
    try {
      await post("/api/auth/login");
    } catch {
      // Terminal failed to open
    }
    setLoginDisabled(false);
  }, []);

  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-header" style={{ padding: "48px 64px 24px" }}>
        <div>
          <h1>Getting started</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Set up your environment to get started.</p>
        </div>
      </div>

      <div style={{ padding: "0 64px 48px" }}>
        <div className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Connect your Claude Code
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
            VoiceCC needs an authenticated Claude Code session to work. The check below verifies your local CLI is logged in.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: authStatus === false ? 16 : 0 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: authStatus === null ? "#666" : authStatus ? "var(--accent-color)" : "#d73a49",
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: 13,
              color: authStatus === null ? "var(--text-secondary)" : authStatus ? "var(--accent-color)" : "#d73a49",
            }}>
              {authStatus === null
                ? "Checking authentication..."
                : authStatus
                  ? "Claude Code is authenticated"
                  : "Claude Code is not authenticated"}
            </span>
          </div>

          {authStatus === false && (
            <div className="settings-actions">
              <button disabled={loginDisabled} onClick={handleLogin}>
                Open Claude Code
              </button>
            </div>
          )}
        </div>

        <div className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Enable calling from anywhere
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
            Call your voice assistant from any device using a browser.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: browserCallRunning === null ? "#666" : browserCallRunning ? "var(--accent-color)" : "#d73a49",
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: 13,
              color: browserCallRunning === null ? "var(--text-secondary)" : browserCallRunning ? "var(--accent-color)" : "#d73a49",
            }}>
              {browserCallRunning === null
                ? "Checking status..."
                : browserCallRunning
                  ? "Browser calling is active"
                  : "Browser calling is not enabled"}
            </span>
          </div>

          {browserCallRunning === false && (
            <div className="settings-actions">
              <Link to="/settings?tab=integrations" style={{ textDecoration: "none" }}>
                <button>Set up in Settings</button>
              </Link>
            </div>
          )}
        </div>

        <div className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            MCP Integrations
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
            Connect external tools and services via MCP servers.
          </p>

          {mcpServers === null && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#666", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Checking...</span>
            </div>
          )}

          {mcpServers !== null && mcpServers.length === 0 && (
            <div className="settings-actions">
              <Link to="/settings?tab=integrations" style={{ textDecoration: "none" }}>
                <button>Set up in Settings</button>
              </Link>
            </div>
          )}

          {mcpServers !== null && mcpServers.length > 0 && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {mcpServers.map((server) => (
                  <div key={server.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: server.status === "connected" ? "var(--accent-color)"
                        : server.status === "needs_auth" ? "#d29922"
                        : "#d73a49",
                      flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 13, color: "var(--text-primary)" }}>{server.name}</span>
                  </div>
                ))}
              </div>
              <div className="settings-actions">
                <Link to="/settings?tab=integrations" style={{ textDecoration: "none" }}>
                  <button>Add more in Settings</button>
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
