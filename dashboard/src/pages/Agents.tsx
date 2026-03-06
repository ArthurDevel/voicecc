/**
 * Agent list page at /agents.
 *
 * Responsibilities:
 * - Fetches and displays all agents as clickable cards
 * - Provides an inline form to create new agents
 * - Navigates to /agents/:id on card click
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface AgentSummary {
  id: string;
  enabled: boolean;
  heartbeatIntervalMinutes: number;
}

interface CreateAgentForm {
  id: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const INITIAL_FORM: CreateAgentForm = {
  id: "",
};

// ============================================================================
// COMPONENT
// ============================================================================

export function Agents() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<CreateAgentForm>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Fetch all agents on mount */
  useEffect(() => {
    get<AgentSummary[]>("/api/agents")
      .then(setAgents)
      .catch(() => {});
  }, []);

  /**
   * Submit the create agent form.
   * POSTs to /api/agents, then refreshes the list and resets the form.
   */
  const handleCreate = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await post("/api/agents", { id: form.id });
      // Refresh list and reset form
      const updated = await get<AgentSummary[]>("/api/agents");
      setAgents(updated);
      setForm(INITIAL_FORM);
      setShowForm(false);
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message || "Failed to create agent";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    setForm(INITIAL_FORM);
    setShowForm(false);
    setError(null);
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      {/* Page Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 32px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>Agents</h2>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            style={{
              padding: "6px 14px",
              background: "var(--btn-primary-bg)",
              color: "var(--btn-primary-text)",
              border: "none",
              borderRadius: 0,
              fontWeight: 500,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Create Agent
          </button>
        )}
      </div>

      {/* Scrollable Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "48px 64px" }}>
        {/* Inline Create Form */}
        {showForm && (
          <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>New Agent</h3>

            {error && (
              <div style={{ marginBottom: 12, padding: "8px 10px", fontSize: 12, color: "#d73a49", background: "var(--bg-tertiary)", borderRadius: 6, border: "1px solid #d73a49" }}>
                {error}
              </div>
            )}

            {/* ID */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", marginBottom: 4, fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>ID</label>
              <input
                type="text"
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                placeholder="my-agent"
                style={{ width: "100%", padding: "6px 10px", fontSize: 13, background: "var(--bg-main)", color: "var(--text-primary)", border: "1px solid var(--border-color)", borderRadius: 0, boxSizing: "border-box" }}
              />
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleCreate}
                disabled={submitting || !form.id.trim()}
                style={{
                  padding: "6px 14px",
                  background: "var(--btn-primary-bg)",
                  color: "var(--btn-primary-text)",
                  border: "none",
                  borderRadius: 0,
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: submitting ? "not-allowed" : "pointer",
                  opacity: submitting || !form.id.trim() ? 0.6 : 1,
                }}
              >
                {submitting ? "Creating..." : "Create"}
              </button>
              <button
                onClick={handleCancel}
                style={{
                  padding: "6px 14px",
                  background: "var(--bg-main)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 0,
                  fontWeight: 500,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Agent Cards */}
        <div className="settings-panel" style={{ padding: 0 }}>
          {agents.length === 0 && !showForm && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              No agents yet. Click "Create Agent" to get started.
            </div>
          )}
          {agents.map((agent) => (
            <div
              key={agent.id}
              onClick={() => navigate(`/agents/${agent.id}`)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "14px 20px",
                borderBottom: "1px solid var(--border-color)",
                cursor: "pointer",
                transition: "background 0.1s ease",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-tertiary)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {/* Enabled status dot */}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: agent.enabled ? "#2ea043" : "#8b949e",
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>{agent.id}</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                every {agent.heartbeatIntervalMinutes}m
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
