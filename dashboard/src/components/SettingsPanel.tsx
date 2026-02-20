/**
 * Settings panel with .env configuration and integration buttons.
 *
 * Renders:
 * - MAX_CONCURRENT_SESSIONS input with load/save
 * - Twilio and WebRTC integration buttons that open setup modals
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";
import { TwilioPanel } from "./TwilioPanel";

// ============================================================================
// TYPES
// ============================================================================

interface SettingsPanelProps {
  ngrokRunning: boolean;
  twilioRunning: boolean;
}

type ModalMode = "twilio" | "webrtc" | null;

// ============================================================================
// COMPONENT
// ============================================================================

export function SettingsPanel({ ngrokRunning, twilioRunning }: SettingsPanelProps) {
  const [maxSessions, setMaxSessions] = useState("");
  const [statusText, setStatusText] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>(null);

  // Load settings on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        setMaxSessions(data.MAX_CONCURRENT_SESSIONS || "");
      })
      .catch(() => setStatusText("Error loading settings"));
  }, []);

  /** Save settings to the server */
  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusText("Saving...");
    try {
      await post("/api/settings", { MAX_CONCURRENT_SESSIONS: maxSessions });
      setStatusText("Saved");
      setTimeout(() => setStatusText((prev) => (prev === "Saved" ? "" : prev)), 2000);
    } catch {
      setStatusText("Error saving settings");
    }
    setSaving(false);
  }, [maxSessions]);

  return (
    <>
      <div className="settings-panel">
        <div className="settings-row">
          <label htmlFor="setting-max-sessions">MAX_CONCURRENT_SESSIONS</label>
          <input
            type="text"
            id="setting-max-sessions"
            placeholder="2"
            value={maxSessions}
            onChange={(e) => setMaxSessions(e.target.value)}
          />
        </div>
        <div className="settings-actions">
          <button disabled={saving} onClick={handleSave}>Save</button>
          <span className="settings-status">{statusText}</span>
        </div>
      </div>

      <div className="integrations-panel">
        <h2>Integrations</h2>
        <span className="btn-integration" style={{ cursor: "default" }}>
          <span className={`integration-dot${ngrokRunning ? " running" : ""}`} />
          ngrok
        </span>
        <button className="btn-integration" style={{ marginLeft: 8 }} onClick={() => setModalMode("twilio")}>
          <span className={`integration-dot${twilioRunning ? " running" : ""}`} />
          Twilio
        </button>
        <button className="btn-integration" style={{ marginLeft: 8 }} onClick={() => setModalMode("webrtc")}>
          <span className={`integration-dot${twilioRunning ? " running" : ""}`} />
          WebRTC
        </button>
      </div>

      {modalMode && (
        <TwilioPanel mode={modalMode} onClose={() => setModalMode(null)} />
      )}
    </>
  );
}
