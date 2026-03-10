/**
 * Main dashboard layout page.
 *
 * Manages active page state (settings vs conversation) and renders:
 * - Sidebar with navigation and conversation list
 * - Content area with either settings panels or conversation viewer
 */

import { useState, useEffect } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { get } from "../api";
import type { LayoutContext } from "../components/Layout";
import { AuthTokenModal } from "../components/AuthTokenModal";

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
  callBaseUrl: string;
}

interface AgentSummary {
  id: string;
  enabled: boolean;
}

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
  scope: "project" | "user" | "local";
}

export function Home() {
  const { authStatus, setAuthStatus } = useOutletContext<LayoutContext>();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [twilioStatus, setTwilioStatus] = useState<TwilioStatus | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[] | null>(null);
  const [showTokenModal, setShowTokenModal] = useState(false);

  useEffect(() => {
    get<AgentSummary[]>("/api/agents")
      .then(setAgents)
      .catch(() => setAgents([]));
    get<TwilioStatus>("/api/twilio/status")
      .then(setTwilioStatus)
      .catch(() => setTwilioStatus({ running: false, tunnelUrl: null }));
    get<{ servers: McpServerEntry[] }>("/api/mcp-servers")
      .then((data) => setMcpServers(data.servers))
      .catch(() => setMcpServers([]));
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

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
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
              <button onClick={() => setShowTokenModal(true)}>Set up authentication</button>
            </div>
          )}
        </div>

        {showTokenModal && (
          <AuthTokenModal
            onClose={() => setShowTokenModal(false)}
            onAuthenticated={() => setAuthStatus(true)}
          />
        )}

        <div className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Your Voice Agents
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
            Create and manage your voice agents.
          </p>

          {agents === null && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#666", flexShrink: 0 }} />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Checking...</span>
            </div>
          )}

          {agents !== null && agents.length === 0 && (
            <div className="settings-actions">
              <Link to="/agents" style={{ textDecoration: "none" }}>
                <button>Create Agent</button>
              </Link>
            </div>
          )}

          {agents !== null && agents.length > 0 && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {agents.map((agent) => (
                  <div key={agent.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: agent.enabled ? "var(--accent-color)" : "#666",
                      flexShrink: 0,
                    }} />
                    <Link to={`/agents/${agent.id}`} style={{ fontSize: 13, color: "var(--text-primary)", textDecoration: "none" }}>
                      {agent.id}
                    </Link>
                  </div>
                ))}
              </div>
              <div className="settings-actions">
                <Link to="/agents" style={{ textDecoration: "none" }}>
                  <button>Manage Agents</button>
                </Link>
              </div>
            </>
          )}
        </div>

        {twilioStatus !== null && !twilioStatus.running && (
          <div className="settings-panel">
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
              Call your agents over the phone
            </h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
              Connect a Twilio phone number to call your voice agents from any phone. Requires a Twilio account and a purchased phone number.
            </p>
            <div className="settings-actions">
              <Link to="/settings?tab=integrations" style={{ textDecoration: "none" }}>
                <button>Set up Twilio</button>
              </Link>
            </div>
          </div>
        )}

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
