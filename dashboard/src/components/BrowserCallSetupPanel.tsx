/**
 * Browser Call from Anywhere -- setup wizard.
 *
 * 2-step modal for configuring direct browser calling via WebSocket + AudioWorklet.
 * No Twilio credentials needed -- cloudflared is auto-managed via the npm package.
 *
 * Steps:
 * - Step 1: Start/stop the browser call server (shows tunnel URL when running)
 * - Step 2: Status summary with link to the call page
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface BrowserCallSetupPanelProps {
  onClose: () => void;
}

interface BrowserCallStatusData {
  running: boolean;
  tunnelUrl: string | null;
}

interface IntegrationsState {
  twilio: { enabled: boolean };
  browserCall: { enabled: boolean };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const POLL_INTERVAL_MS = 5000;

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Setup wizard for "Browser Call from Anywhere".
 * Polls /api/browser-call/status every 5s. Checks cloudflared via /api/tunnel/check.
 * Starts/stops via /api/browser-call/start and /stop.
 *
 * @param props.onClose - callback to close the modal
 */
export function BrowserCallSetupPanel({ onClose }: BrowserCallSetupPanelProps) {
  const [status, setStatus] = useState<BrowserCallStatusData | null>(null);
  const [actionText, setActionText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Load integration state on mount
  useEffect(() => {
    get<IntegrationsState>("/api/integrations")
      .then((data) => setEnabled(data.browserCall.enabled))
      .catch(() => {});

    pollStatus();
    const interval = setInterval(pollStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Poll browser call server status */
  const pollStatus = () => {
    get<BrowserCallStatusData>("/api/browser-call/status").then(setStatus).catch(() => {});
  };

  /** Toggle the Browser Call integration enabled state */
  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setToggling(true);
    try {
      await post("/api/integrations/browser-call", { enabled: newEnabled });
      setEnabled(newEnabled);
      pollStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed";
      setActionText(message);
      setTimeout(() => setActionText(""), 4000);
    } finally {
      setToggling(false);
    }
  }, [enabled]);

  /** Close modal when clicking overlay background */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  const isRunning = status?.running ?? false;
  const callPageUrl = status?.tunnelUrl ? `${status.tunnelUrl}/call` : null;

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Browser Call from Anywhere</h2>

        {/* Step 1: Enable integration */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            {isRunning ? "Server running" : "Enable integration"}
          </div>
          <div className="setup-step-desc">
            {isRunning
              ? <>Server is running.{status?.tunnelUrl && <> Tunnel URL: <code>{status.tunnelUrl}</code></>}</>
              : "Enable to start the browser call server and auto-start on boot."
            }
            {actionText && <div style={{ color: "#d73a49", marginTop: 4, fontSize: 12 }}>{actionText}</div>}
          </div>
          <div className="setup-paste-row">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: toggling ? "wait" : "pointer" }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={toggling}
                onChange={handleToggle}
                style={{ width: 16, height: 16, cursor: toggling ? "wait" : "pointer" }}
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                {toggling ? (enabled ? "Stopping..." : "Starting...") : "Enabled"}
              </span>
            </label>
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 2: Status + call page link */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">2</span>
            Call from any device
          </div>
          <div className="setup-step-desc">
            {callPageUrl ? (
              <>
                Open this URL on any device to start a voice call:<br />
                <a href={callPageUrl} target="_blank" rel="noreferrer" style={{ wordBreak: "break-all" }}>{callPageUrl}</a><br />
                Or use the <strong>Call via Browser</strong> button in the sidebar to get a QR code.
              </>
            ) : (
              'Start the server first (step 2), then the call page URL will appear here.'
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

