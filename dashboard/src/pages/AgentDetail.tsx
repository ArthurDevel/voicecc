/**
 * Read-only agent detail page at /agents/:id.
 *
 * Responsibilities:
 * - Fetches and displays full agent data (SOUL.md, MEMORY.md, HEARTBEAT.md, config)
 * - Provides a "Call Me" button to trigger an outbound call
 * - Provides a "Delete" button with confirmation to remove the agent
 */

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { get, post, del } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface AgentConfig {
  heartbeatIntervalMinutes: number;
  phoneNumber: string;
  enabled: boolean;
}

interface Agent {
  id: string;
  soulMd: string;
  memoryMd: string;
  heartbeatMd: string;
  config: AgentConfig;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 12,
  fontSize: 13,
  fontFamily: "monospace",
  whiteSpace: "pre-wrap",
  wordWrap: "break-word",
  background: "var(--bg-main)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-color)",
  borderRadius: 0,
};

const SECTION_LABEL_STYLE: React.CSSProperties = {
  margin: "0 0 8px",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text-primary)",
};

// ============================================================================
// COMPONENT
// ============================================================================

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Fetch agent data on mount */
  useEffect(() => {
    if (!id) return;
    get<Agent>(`/api/agents/${id}`)
      .then(setAgent)
      .catch(() => {});
  }, [id]);

  /**
   * Trigger an outbound call for this agent.
   * POSTs to /api/agents/:id/call.
   */
  const handleCall = async () => {
    if (!id) return;
    setCalling(true);
    setCallError(null);
    try {
      await post(`/api/agents/${id}/call`);
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message || "Failed to initiate call";
      setCallError(message);
    } finally {
      setCalling(false);
    }
  };

  /**
   * Delete this agent after confirmation.
   * DELETEs /api/agents/:id, then navigates to /agents.
   */
  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm(`Delete agent "${id}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await del(`/api/agents/${id}`);
      navigate("/agents");
    } catch {
      setDeleting(false);
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  if (!agent) {
    return (
      <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
        <div style={{ padding: "24px 32px", color: "var(--text-secondary)", fontSize: 14 }}>Loading...</div>
      </div>
    );
  }

  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      {/* Page Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 32px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Link to="/agents" style={{ fontSize: 13, color: "var(--text-secondary)", textDecoration: "none" }}>
            Agents
          </Link>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>/</span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>{agent.id}</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleCall}
            disabled={calling}
            style={{
              padding: "6px 14px",
              background: "var(--btn-primary-bg)",
              color: "var(--btn-primary-text)",
              border: "none",
              borderRadius: 0,
              fontWeight: 500,
              fontSize: 13,
              cursor: calling ? "not-allowed" : "pointer",
              opacity: calling ? 0.6 : 1,
            }}
          >
            {calling ? "Calling..." : "Call Me"}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color: "#d73a49",
              border: "1px solid #d73a49",
              borderRadius: 0,
              fontWeight: 500,
              fontSize: 13,
              cursor: deleting ? "not-allowed" : "pointer",
              opacity: deleting ? 0.6 : 1,
            }}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      {/* Call error banner */}
      {callError && (
        <div style={{ margin: "16px 32px 0", padding: "8px 10px", fontSize: 12, color: "#d73a49", background: "var(--bg-tertiary)", borderRadius: 6, border: "1px solid #d73a49" }}>
          {callError}
        </div>
      )}

      {/* Scrollable Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "48px 64px" }}>
        {/* SOUL.md */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>SOUL.md</h3>
          <pre style={PRE_STYLE}>{agent.soulMd || "(empty)"}</pre>
        </div>

        {/* MEMORY.md */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>MEMORY.md</h3>
          <pre style={PRE_STYLE}>{agent.memoryMd || "(empty)"}</pre>
        </div>

        {/* HEARTBEAT.md */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>HEARTBEAT.md</h3>
          <pre style={PRE_STYLE}>{agent.heartbeatMd || "(empty)"}</pre>
        </div>

        {/* Config */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>Config</h3>
          <pre style={PRE_STYLE}>{JSON.stringify(agent.config, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
