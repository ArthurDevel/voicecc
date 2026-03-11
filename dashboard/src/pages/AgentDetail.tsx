/**
 * Read-only agent detail page at /agents/:id.
 *
 * Responsibilities:
 * - Fetches and displays full agent data (SOUL.md, MEMORY.md, HEARTBEAT.md, config)
 * - Provides a "Call Me" button to trigger an outbound call
 * - Provides a "Delete" button with confirmation to remove the agent
 */

import { useState, useEffect } from "react";
import { useParams, useNavigate, Link, useOutletContext } from "react-router-dom";
import { get, post, del, patch } from "../api";
import type { LayoutContext } from "../components/Layout";
import { BrowserCallModal } from "../components/BrowserCallModal";

// ============================================================================
// TYPES
// ============================================================================

interface VoicePreference {
  id: string;
  name: string;
}

interface AgentConfig {
  heartbeatIntervalMinutes: number;
  phoneNumber: string;
  enabled: boolean;
  voice?: {
    elevenlabs?: VoicePreference;
    local?: VoicePreference;
  };
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
  const { browserCallStatus } = useOutletContext<LayoutContext>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [calling, setCalling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [voices, setVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [savingVoice, setSavingVoice] = useState(false);
  const [showBrowserCallModal, setShowBrowserCallModal] = useState(false);

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

  /** Fetch active TTS provider and available voices */
  useEffect(() => {
    get<{ active: string }>("/api/providers/tts")
      .then((data) => {
        setActiveProvider(data.active);
        return get<{ voices: Array<{ id: string; name: string }> }>(
          `/api/providers/tts/${data.active}/voices`
        );
      })
      .then((data) => setVoices(data.voices))
      .catch((err) => setVoicesError((err as { message?: string })?.message || "Failed to load voices"));
  }, []);

  /** Update the agent's voice preference for the active provider */
  const handleVoiceChange = async (voiceId: string) => {
    if (!id || !agent || !activeProvider) return;
    setSavingVoice(true);
    try {
      const providerKey = activeProvider as "elevenlabs";
      const existingVoice = agent.config.voice ?? {};
      const newVoice = { ...existingVoice, [providerKey]: { id: voiceId, name: voices.find((v) => v.id === voiceId)?.name ?? "" } };
      await patch(`/api/agents/${id}`, { config: { voice: newVoice } });
      setAgent({ ...agent, config: { ...agent.config, voice: newVoice } });
    } finally {
      setSavingVoice(false);
    }
  };

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
   * Export agent as a zip download.
   * Uses fetch instead of <a download> to surface errors properly.
   */
  const handleExport = async () => {
    if (!id) return;
    try {
      console.log(`[export-ui] Fetching /api/agents/${id}/export`);
      const res = await fetch(`/api/agents/${id}/export`);
      console.log(`[export-ui] Response status: ${res.status}, content-type: ${res.headers.get("content-type")}`);
      if (!res.ok) {
        const text = await res.text();
        console.error(`[export-ui] Export failed: ${res.status} - ${text}`);
        alert(`Export failed: ${text}`);
        return;
      }
      const blob = await res.blob();
      console.log(`[export-ui] Blob size: ${blob.size}, type: ${blob.type}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${id}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      console.log(`[export-ui] Download triggered for ${id}.zip`);
    } catch (err) {
      console.error("[export-ui] Export error:", err);
      alert(`Export failed: ${err}`);
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
            onClick={handleExport}
            style={{
              padding: "6px 14px",
              background: "var(--bg-main)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: 0,
              fontWeight: 500,
              fontSize: 13,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            Export
          </button>
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
            {calling ? "Calling..." : "Call via Phone"}
          </button>
          <button
            onClick={() => setShowBrowserCallModal(true)}
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
            Call via Browser
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

        {/* Voice */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>Voice</h3>
          {activeProvider && voices.length > 0 ? (
            <div>
              <label style={{ display: "block", fontSize: 13, color: "var(--text-secondary)", marginBottom: 6 }}>
                ElevenLabs voice
              </label>
              <select
                value={agent.config.voice?.[activeProvider as "elevenlabs"]?.id ?? ""}
                onChange={(e) => handleVoiceChange(e.target.value)}
                disabled={savingVoice}
                style={{
                  padding: "6px 10px",
                  fontSize: 13,
                  background: "var(--bg-main)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 0,
                  cursor: savingVoice ? "not-allowed" : "pointer",
                  opacity: savingVoice ? 0.6 : 1,
                  minWidth: 200,
                }}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            </div>
          ) : voicesError ? (
            <p style={{ margin: 0, fontSize: 13, color: "#d73a49" }}>{voicesError}</p>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>Loading voices...</p>
          )}
        </div>

        {/* Config */}
        <div className="settings-panel" style={{ marginBottom: 24, padding: 20 }}>
          <h3 style={SECTION_LABEL_STYLE}>Config</h3>
          <pre style={PRE_STYLE}>{JSON.stringify(agent.config, null, 2)}</pre>
        </div>
      </div>

      {showBrowserCallModal && browserCallStatus.callBaseUrl && id && (
        <BrowserCallModal
          agentId={id!}
          callBaseUrl={browserCallStatus.callBaseUrl}
          onClose={() => setShowBrowserCallModal(false)}
        />
      )}
    </div>
  );
}
