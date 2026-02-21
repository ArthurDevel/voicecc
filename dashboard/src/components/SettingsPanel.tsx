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
      setStatusText("Saved!");
      setTimeout(() => setStatusText((prev) => (prev === "Saved!" ? "" : prev)), 2000);
    } catch {
      setStatusText("Error saving settings");
    }
    setSaving(false);
  }, [maxSessions]);

  return (
    <div className="settings-panel">
      <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>General Options</h2>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>Configure the core behavior of your voice assistant instance.</p>

      <div className="settings-row">
        <label htmlFor="setting-max-sessions" style={{ fontWeight: 500, color: "var(--text-primary)" }}>Max Concurrent Sessions</label>
        <input
          type="text"
          id="setting-max-sessions"
          placeholder="2"
          value={maxSessions}
          onChange={(e) => setMaxSessions(e.target.value)}
        />
      </div>

      <div className="settings-actions" style={{ marginTop: 20 }}>
        <button disabled={saving} onClick={handleSave}>Save changes</button>
        <span className="settings-status">{statusText}</span>
      </div>
    </div>
  );
}
