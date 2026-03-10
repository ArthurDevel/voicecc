/**
 * Settings panel with .env configuration and tunnel control.
 *
 * Renders:
 * - Tunnel section (enable/disable, shows URL when running)
 * - General options (max sessions, phone number)
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";
import type { TunnelStatus } from "../pages/Home";
import { AuthTokenModal } from "./AuthTokenModal";

// ============================================================================
// TYPES
// ============================================================================

interface SettingsPanelProps {
  twilioRunning: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const POLL_INTERVAL_MS = 5000;

// ============================================================================
// COMPONENT
// ============================================================================

interface AuthInfo {
  authenticated: boolean;
  authMethod: string;
  email?: string;
}

export function SettingsPanel({ twilioRunning }: SettingsPanelProps) {
  const [maxSessions, setMaxSessions] = useState("");
  const [userPhoneNumber, setUserPhoneNumber] = useState("");
  const [statusText, setStatusText] = useState("");
  const [saving, setSaving] = useState(false);

  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus>({ running: false, url: null });
  const [tunnelToggling, setTunnelToggling] = useState(false);
  const [tunnelError, setTunnelError] = useState("");

  const [authInfo, setAuthInfo] = useState<AuthInfo | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const fetchAuth = useCallback(() => {
    get<AuthInfo>("/api/auth").then(setAuthInfo).catch(() => setAuthInfo(null));
  }, []);

  // Load settings and auth on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        setMaxSessions(data.MAX_CONCURRENT_SESSIONS || "");
        setUserPhoneNumber(data.USER_PHONE_NUMBER || "");
      })
      .catch(() => setStatusText("Error loading settings"));
    fetchAuth();
  }, [fetchAuth]);

  // Poll tunnel status
  useEffect(() => {
    const poll = () => {
      get<TunnelStatus>("/api/tunnel/status").then(setTunnelStatus).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Save settings to the server */
  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatusText("Saving...");
    try {
      await post("/api/settings", { MAX_CONCURRENT_SESSIONS: maxSessions, USER_PHONE_NUMBER: userPhoneNumber });
      setStatusText("Saved!");
      setTimeout(() => setStatusText((prev) => (prev === "Saved!" ? "" : prev)), 2000);
    } catch {
      setStatusText("Error saving settings");
    }
    setSaving(false);
  }, [maxSessions, userPhoneNumber]);

  /** Toggle the tunnel on or off */
  const handleTunnelToggle = useCallback(async () => {
    setTunnelToggling(true);
    setTunnelError("");
    try {
      if (tunnelStatus.running) {
        await post("/api/tunnel/stop");
      } else {
        await post("/api/tunnel/start");
      }
      // Give it a moment then refresh status
      const updated = await get<TunnelStatus>("/api/tunnel/status");
      setTunnelStatus(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed";
      setTunnelError(message);
      setTimeout(() => setTunnelError(""), 5000);
    } finally {
      setTunnelToggling(false);
    }
  }, [tunnelStatus.running]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <>
      <div className="page-header" style={{ borderBottom: "none", padding: 0, marginBottom: 24 }}>
        <div>
          <h1>General Settings</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Manage your workspace settings and core behavior.</p>
        </div>
      </div>

      {/* Authentication */}
      <div className="settings-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Authentication</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
          Claude Code authentication status for this server.
        </p>

        {authInfo === null && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>Checking...</div>
        )}

        {authInfo && !authInfo.authenticated && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#d73a49", flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>Not authenticated</span>
            </div>
            <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
              Claude Code is not logged in. Sign in to enable voice sessions.
            </p>
            <button
              onClick={() => setShowAuthModal(true)}
              style={{
                background: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                borderRadius: 0,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
                fontFamily: "inherit",
                cursor: "pointer",
                transition: "all 0.2s",
              }}
            >
              Sign in
            </button>
          </div>
        )}

        {authInfo && authInfo.authenticated && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", flexShrink: 0 }} />
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                Authenticated
                {authInfo.authMethod === "claude.ai" && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--accent-color)",
                    background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
                    padding: "2px 6px",
                    borderRadius: 4,
                    marginLeft: 8,
                  }}>
                    Claude.ai OAuth
                  </span>
                )}
                {authInfo.authMethod !== "claude.ai" && authInfo.authMethod !== "none" && (
                  <span style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    background: "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
                    padding: "2px 6px",
                    borderRadius: 4,
                    marginLeft: 8,
                  }}>
                    {authInfo.authMethod}
                  </span>
                )}
              </span>
            </div>
            {authInfo.email && (
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 8 }}>
                {authInfo.email}
              </p>
            )}
            {authInfo.authMethod !== "claude.ai" && (
              <div style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                background: "color-mix(in srgb, var(--warning-color, #f59e0b) 8%, transparent)",
                border: "1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 20%, transparent)",
                padding: "8px 12px",
                borderRadius: 6,
                marginTop: 8,
                lineHeight: 1.5,
              }}>
                Authenticated via token. Cloud MCP servers (Gmail, Google Calendar, Slack, etc.)
                are not available with this method.{" "}
                <button
                  onClick={() => setShowAuthModal(true)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent-color)",
                    cursor: "pointer",
                    padding: 0,
                    fontSize: 12,
                    fontWeight: 600,
                    textDecoration: "underline",
                  }}
                >
                  Switch to Claude.ai login
                </button>
              </div>
            )}
            <button
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                try {
                  const status = await post<AuthInfo>("/api/auth/logout");
                  setAuthInfo(status);
                } catch {
                  fetchAuth();
                } finally {
                  setLoggingOut(false);
                }
              }}
              style={{
                marginTop: 16,
                background: "none",
                border: "1px solid var(--border-color)",
                color: "var(--text-secondary)",
                cursor: loggingOut ? "wait" : "pointer",
                padding: "6px 14px",
                fontSize: 13,
              }}
            >
              {loggingOut ? "Logging out..." : "Log out"}
            </button>
          </div>
        )}
      </div>

      {showAuthModal && (
        <AuthTokenModal
          onClose={() => setShowAuthModal(false)}
          onAuthenticated={() => { setShowAuthModal(false); fetchAuth(); }}
        />
      )}

      {/* Tunnel */}
      <div className="settings-panel">
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Public Tunnel</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
          Exposes your voice server via a Cloudflare tunnel. Required if you want to access VoiceCC on a remote server, and/or want to make use of phone calling.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: tunnelToggling ? "wait" : "pointer" }}>
            <input
              type="checkbox"
              checked={tunnelStatus.running}
              disabled={tunnelToggling}
              onChange={handleTunnelToggle}
              style={{ width: 16, height: 16, cursor: tunnelToggling ? "wait" : "pointer" }}
            />
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
              {tunnelToggling
                ? (tunnelStatus.running ? "Stopping..." : "Starting...")
                : (tunnelStatus.running ? "Enabled" : "Disabled")}
            </span>
          </label>
        </div>

        {tunnelStatus.running && tunnelStatus.url && (
          <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            URL: <code style={{ userSelect: "all", cursor: "text" }}>{tunnelStatus.url}</code>
          </div>
        )}

        {tunnelError && (
          <div style={{ color: "#d73a49", marginTop: 8, fontSize: 12 }}>{tunnelError}</div>
        )}
      </div>

      {/* General Options */}
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

        <div className="settings-row">
          <label htmlFor="setting-user-phone" style={{ fontWeight: 500, color: "var(--text-primary)" }}>Your Phone Number</label>
          <input
            type="text"
            id="setting-user-phone"
            placeholder="+15551234567"
            value={userPhoneNumber}
            onChange={(e) => setUserPhoneNumber(e.target.value)}
          />
        </div>

        <div className="settings-actions" style={{ marginTop: 20 }}>
          <button disabled={saving} onClick={handleSave}>Save changes</button>
          <span className="settings-status">{statusText}</span>
        </div>
      </div>
    </>
  );
}
