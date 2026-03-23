/**
 * WhatsApp setup modal wizard.
 *
 * Step-by-step modal for enabling the integration, linking a WhatsApp
 * account via QR code, and viewing/syncing agent group mappings.
 *
 * Responsibilities:
 * - Step 1: Enable/disable integration toggle
 * - Step 2: QR code display + connection status (polls /api/whatsapp/status)
 * - Step 3: Agent groups list with sync status
 */

import { useState, useEffect, useCallback } from "react";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface WhatsAppPanelProps {
  onClose: () => void;
}

interface WhatsAppStatusData {
  status: "disconnected" | "qr_pending" | "connecting" | "connected";
  qrCode: string | null;
}

interface IntegrationsState {
  whatsapp: { enabled: boolean };
}

interface GroupMapping {
  groupJid: string;
  agentId: string;
  lastSessionId: string | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Fast polling interval while QR code is showing (ms) */
const QR_POLL_INTERVAL_MS = 2_000;

/** Normal polling interval for status updates (ms) */
const STATUS_POLL_INTERVAL_MS = 5_000;

// ============================================================================
// COMPONENT
// ============================================================================

export function WhatsAppPanel({ onClose }: WhatsAppPanelProps) {
  const [status, setStatus] = useState<WhatsAppStatusData | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [actionText, setActionText] = useState("");
  const [groups, setGroups] = useState<GroupMapping[]>([]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Fetch current WhatsApp connection status */
  const pollStatus = useCallback(() => {
    get<WhatsAppStatusData>("/api/whatsapp/status").then(setStatus).catch(() => {});
  }, []);

  /** Fetch current group mappings */
  const fetchGroups = useCallback(() => {
    get<{ groups: GroupMapping[] }>("/api/whatsapp/groups")
      .then((data) => setGroups(data.groups))
      .catch(() => {});
  }, []);

  /** Toggle the WhatsApp integration enabled state */
  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setToggling(true);
    try {
      await post("/api/integrations/whatsapp", { enabled: newEnabled });
      setEnabled(newEnabled);
      pollStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed";
      setActionText(message);
      setTimeout(() => setActionText(""), 4000);
    } finally {
      setToggling(false);
    }
  }, [enabled, pollStatus]);

  /** Close modal when clicking overlay background */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ============================================================================
  // EFFECTS
  // ============================================================================

  // Load integration state and start polling on mount
  useEffect(() => {
    get<IntegrationsState>("/api/integrations")
      .then((data) => setEnabled(data.whatsapp.enabled))
      .catch(() => {});

    pollStatus();
    fetchGroups();
  }, [pollStatus, fetchGroups]);

  // Poll status at different intervals depending on whether QR is showing
  useEffect(() => {
    const interval = status?.status === "qr_pending" ? QR_POLL_INTERVAL_MS : STATUS_POLL_INTERVAL_MS;
    const timer = setInterval(() => {
      pollStatus();
      fetchGroups();
    }, interval);
    return () => clearInterval(timer);
  }, [status?.status, pollStatus, fetchGroups]);

  const isConnected = status?.status === "connected";

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>WhatsApp Setup</h2>

        {/* Step 1: Enable integration */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            Enable integration
          </div>
          <div className="setup-step-desc">
            {enabled
              ? "WhatsApp integration is enabled. It will auto-start on boot."
              : "Enable to start the WhatsApp connection."
            }
            {actionText && <div style={{ color: "#d73a49", marginTop: 4, fontSize: 12 }}>{actionText}</div>}
          </div>
          <div className="setup-paste-row">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: toggling ? "not-allowed" : "pointer" }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={toggling}
                onChange={handleToggle}
                style={{ width: 16, height: 16, cursor: toggling ? "not-allowed" : "pointer" }}
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                {toggling ? (enabled ? "Stopping..." : "Starting...") : "Enabled"}
              </span>
            </label>
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 2: Link WhatsApp via QR code */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">2</span>
            Link WhatsApp
          </div>
          <div className="setup-step-desc">
            {!enabled && "Enable the integration above to get started."}
            {enabled && status?.status === "disconnected" && "Waiting for connection..."}
            {enabled && status?.status === "connecting" && "Connecting to WhatsApp..."}
            {enabled && status?.status === "qr_pending" && "Scan this QR code with WhatsApp on your phone (Settings > Linked Devices > Link a Device)."}
            {enabled && isConnected && "WhatsApp is connected."}
          </div>

          {/* QR Code display */}
          {enabled && status?.status === "qr_pending" && status.qrCode && (
            <div style={{ display: "flex", justifyContent: "center", padding: "16px 0" }}>
              <QRCodeSVG value={status.qrCode} size={256} />
            </div>
          )}

          {/* Connection status indicator */}
          {enabled && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <span
                className={`integration-dot${isConnected ? " running" : ""}`}
              />
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {status?.status === "connected" && "Connected"}
                {status?.status === "qr_pending" && "Waiting for QR scan"}
                {status?.status === "connecting" && "Connecting..."}
                {status?.status === "disconnected" && "Disconnected"}
                {!status && "Loading..."}
              </span>
            </div>
          )}
        </div>

        <hr className="setup-divider" />

        {/* Step 3: Agent groups */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">3</span>
            Agent groups
          </div>
          <div className="setup-step-desc">
            Each agent gets a WhatsApp group named [VoiceCC] &lt;agentId&gt;. Groups are created
            automatically when WhatsApp connects. Send messages in a group to chat with that agent.
          </div>

          {groups.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 8 }}>
              {isConnected ? "No groups created yet. Groups sync automatically when agents exist." : "Connect WhatsApp to see agent groups."}
            </div>
          )}

          {groups.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {groups.map((g) => (
                <div key={g.groupJid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border-color)" }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>[VoiceCC] {g.agentId}</span>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)", marginLeft: "auto" }}>{g.groupJid}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Warning note at the bottom */}
        <div style={{ marginTop: 16, padding: "10px 12px", background: "var(--bg-tertiary)", borderRadius: 6, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Baileys is a reverse-engineered WhatsApp Web protocol. Use a separate phone number -- WhatsApp may throttle or block accounts used for automated messaging.
        </div>
      </div>
    </div>
  );
}
