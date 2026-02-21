/**
 * Browser Call from Anywhere -- setup wizard.
 *
 * 4-step modal for configuring direct browser calling via WebSocket + AudioWorklet.
 * No Twilio credentials needed -- only ngrok for tunneling.
 *
 * Steps:
 * - Step 1: Check ngrok is installed
 * - Step 2: Enter ngrok authtoken
 * - Step 3: Start/stop the browser call server (shows ngrok URL when running)
 * - Step 4: Status summary with link to the call page
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
  ngrokUrl: string | null;
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
 * Polls /api/browser-call/status every 5s. Checks ngrok via /api/ngrok/check.
 * Saves ngrok authtoken via /api/settings. Starts/stops via /api/browser-call/start and /stop.
 *
 * @param props.onClose - callback to close the modal
 */
export function BrowserCallSetupPanel({ onClose }: BrowserCallSetupPanelProps) {
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokInstalled, setNgrokInstalled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<BrowserCallStatusData | null>(null);
  const [actionText, setActionText] = useState("");

  // Load current ngrok authtoken + check ngrok installation on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        if (data.NGROK_AUTHTOKEN) setNgrokToken(data.NGROK_AUTHTOKEN);
      })
      .catch(() => {});

    checkNgrok();
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

  /** Check if ngrok binary is installed */
  const checkNgrok = () => {
    setNgrokInstalled(null);
    get<{ installed: boolean }>("/api/ngrok/check")
      .then((data) => setNgrokInstalled(data.installed))
      .catch(() => setNgrokInstalled(false));
  };

  /**
   * Save a single setting to .env
   * @param key - the env variable name
   * @param value - the value to save
   * @returns true if save succeeded
   */
  const saveSetting = useCallback(async (key: string, value: string): Promise<boolean> => {
    try {
      await post("/api/settings", { [key]: value });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Save ngrok authtoken and start the browser call server + ngrok */
  const handleSaveAndStart = useCallback(async () => {
    setActionText("Saving...");
    if (ngrokToken.trim()) {
      await post("/api/settings", { NGROK_AUTHTOKEN: ngrokToken.trim() });
    }

    setActionText("Starting...");
    try {
      await post("/api/browser-call/start");
      pollStatus();
      setActionText("");
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed to start";
      setActionText(message);
      setTimeout(() => setActionText(""), 4000);
    }
  }, [ngrokToken]);

  /** Stop the browser call server */
  const handleStop = useCallback(async () => {
    await post("/api/browser-call/stop");
    pollStatus();
  }, []);

  /** Close modal when clicking overlay background */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  const isRunning = status?.running ?? false;
  const callPageUrl = status?.ngrokUrl ? `${status.ngrokUrl}/call` : null;

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Browser Call from Anywhere</h2>

        {/* Step 1: Install ngrok */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            Install ngrok
          </div>
          <div className="setup-step-desc">
            ngrok tunnels your local server so remote devices can reach it.
            Install from <a href="https://ngrok.com/download" target="_blank" rel="noreferrer">ngrok.com/download</a> or via Homebrew:
          </div>
          <CopyBlock text="brew install ngrok" />
          <div className="setup-paste-row">
            <span style={{ fontSize: 12, color: ngrokInstalled === true ? "#2ea043" : ngrokInstalled === false ? "#d73a49" : "#999" }}>
              {ngrokInstalled === null ? "Checking..." : ngrokInstalled ? "ngrok is installed" : "ngrok not found"}
            </span>
            <button style={{ background: "#333", border: "1px solid #404040", color: "#999" }} onClick={checkNgrok}>
              Re-check
            </button>
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 2: ngrok authtoken */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">2</span>
            ngrok authtoken
          </div>
          <div className="setup-step-desc">
            Copy your authtoken from <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noreferrer">dashboard.ngrok.com</a> and paste it below.
          </div>
          <div className="setup-paste-row">
            <input
              type="text"
              placeholder="ngrok authtoken"
              value={ngrokToken}
              onChange={(e) => setNgrokToken(e.target.value)}
            />
            <ApplyButton onClick={() => saveSetting("NGROK_AUTHTOKEN", ngrokToken.trim())} />
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 3: Start/Stop server */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">3</span>
            {isRunning ? "Server running" : "Start server"}
          </div>
          <div className="setup-step-desc">
            {isRunning
              ? <>Server is running.{status?.ngrokUrl && <> ngrok URL: <code>{status.ngrokUrl}</code></>}</>
              : "Click below to save your ngrok authtoken and launch the browser call server + ngrok."
            }
          </div>
          <div className="setup-paste-row">
            {isRunning ? (
              <button style={{ flex: 1, background: "#6e3630" }} onClick={handleStop}>Stop Server</button>
            ) : (
              <button style={{ flex: 1 }} disabled={!!actionText} onClick={handleSaveAndStart}>
                {actionText || "Save Settings & Start Server"}
              </button>
            )}
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 4: Status + call page link */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">4</span>
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
              'Start the server first (step 3), then the call page URL will appear here.'
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/**
 * Inline code block with a copy button on the right.
 * Shows "Copied" briefly after clicking.
 * @param props.text - the text to display and copy
 */
function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      border: "1px solid var(--border-color)",
      borderRadius: 4,
      padding: "6px 8px 6px 12px",
      marginTop: 8,
      background: "var(--bg-main)",
    }}>
      <code style={{ flex: 1, fontSize: 13, userSelect: "all" }}>{text}</code>
      <button
        onClick={handleCopy}
        style={{
          marginLeft: 8,
          padding: "2px 10px",
          fontSize: 12,
          background: "transparent",
          border: "1px solid var(--border-color)",
          borderRadius: 3,
          color: copied ? "#2ea043" : "var(--text-secondary)",
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Small "Apply" button that shows "Saved" briefly after clicking.
 * @param props.onClick - async handler that returns true on success
 */
function ApplyButton({ onClick }: { onClick: () => Promise<boolean> }) {
  const [text, setText] = useState("Apply");
  const [applied, setApplied] = useState(false);

  const handleClick = async () => {
    setText("Saving...");
    const ok = await onClick();
    setText(ok ? "Saved" : "Error");
    setApplied(ok);
    setTimeout(() => {
      setText("Apply");
      setApplied(false);
    }, 1500);
  };

  return (
    <button className={applied ? "applied" : ""} onClick={handleClick}>
      {text}
    </button>
  );
}
