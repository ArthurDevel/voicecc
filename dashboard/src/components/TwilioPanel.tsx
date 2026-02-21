/**
 * Twilio PSTN voice setup modal wizard.
 *
 * Step-by-step modal for configuring Twilio credentials, ngrok,
 * and phone number for PSTN calling. Steps:
 * 1. Create a Twilio account (credentials)
 * 2. Get a phone number
 * 3. Install ngrok
 * 4. Start server
 * 5. Configure webhook
 * 6. Your phone number
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface TwilioPanelProps {
  onClose: () => void;
}

interface TwilioStatusData {
  running: boolean;
  ngrokUrl: string | null;
}

interface PhoneNumber {
  phoneNumber: string;
  friendlyName: string;
}

interface IntegrationsState {
  twilio: { enabled: boolean };
  browserCall: { enabled: boolean };
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TwilioPanel({ onClose }: TwilioPanelProps) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokInstalled, setNgrokInstalled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<TwilioStatusData | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [actionText, setActionText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);

  // Load current settings, integration state, and check ngrok on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        if (data.TWILIO_ACCOUNT_SID) setAccountSid(data.TWILIO_ACCOUNT_SID);
        if (data.TWILIO_AUTH_TOKEN) setAuthToken(data.TWILIO_AUTH_TOKEN);
        if (data.NGROK_AUTHTOKEN) setNgrokToken(data.NGROK_AUTHTOKEN);
      })
      .catch(() => {});

    get<IntegrationsState>("/api/integrations")
      .then((data) => setEnabled(data.twilio.enabled))
      .catch(() => {});

    checkNgrok();
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch phone numbers when credentials are set
  useEffect(() => {
    if (accountSid && authToken) {
      get<{ numbers: PhoneNumber[] }>("/api/twilio/phone-numbers")
        .then((data) => setPhoneNumbers(data.numbers || []))
        .catch(() => {});
    }
  }, [accountSid, authToken]);

  /** Poll Twilio status */
  const pollStatus = () => {
    get<TwilioStatusData>("/api/twilio/status").then(setStatus).catch(() => {});
  };

  /** Check if ngrok is installed */
  const checkNgrok = () => {
    setNgrokInstalled(null);
    get<{ installed: boolean }>("/api/ngrok/check")
      .then((data) => setNgrokInstalled(data.installed))
      .catch(() => setNgrokInstalled(false));
  };

  /**
   * Save a single setting to .env.
   *
   * @param key - The .env key to save
   * @param value - The value to save
   * @returns True if save succeeded
   */
  const saveSetting = useCallback(async (key: string, value: string): Promise<boolean> => {
    try {
      await post("/api/settings", { [key]: value });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Toggle the Twilio integration enabled state */
  const handleToggle = useCallback(async () => {
    const newEnabled = !enabled;
    setToggling(true);
    try {
      await post("/api/integrations/twilio", { enabled: newEnabled });
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

  const isRunning = status?.running ?? false;
  const webhookUrl = status?.ngrokUrl ? `${status.ngrokUrl}/twilio/incoming-call` : null;

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Twilio Voice Setup</h2>

        {/* Step 1: Credentials */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            Create a Twilio account
          </div>
          <div className="setup-step-desc">
            Sign up at <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">twilio.com/try-twilio</a>.
            Copy your Account SID and Auth Token from the console dashboard.
          </div>
          <div className="setup-paste-row">
            <input
              type="text"
              placeholder="Account SID (ACxxxxxxxx...)"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value)}
            />
            <ApplyButton onClick={() => saveSetting("TWILIO_ACCOUNT_SID", accountSid.trim())} />
          </div>
          <div className="setup-paste-row">
            <input
              type="text"
              placeholder="Auth Token"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
            />
            <ApplyButton onClick={() => saveSetting("TWILIO_AUTH_TOKEN", authToken.trim())} />
          </div>
        </div>

        {/* Step 2: Phone number */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">2</span>Get a phone number</div>
          <div className="setup-step-desc">
            In the Twilio console, go to <strong>Phone Numbers</strong> &rarr; <strong>Buy a Number</strong>.
            Pick any number with voice capability.
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 3: ngrok */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">3</span>
            Install ngrok
          </div>
          <div className="setup-step-desc">
            ngrok tunnels your local server so Twilio can reach it.
            Install from <a href="https://ngrok.com/download" target="_blank" rel="noreferrer">ngrok.com/download</a>
            {" "}or via: <code>brew install ngrok</code>
          </div>
          <div className="setup-paste-row">
            <span style={{ fontSize: 12, color: ngrokInstalled === true ? "#2ea043" : ngrokInstalled === false ? "#d73a49" : "#999" }}>
              {ngrokInstalled === null ? "Checking..." : ngrokInstalled ? "ngrok is installed" : "ngrok not found"}
            </span>
            <button style={{ background: "#333", border: "1px solid #404040", color: "#999" }} onClick={checkNgrok}>
              Re-check
            </button>
          </div>
          <div className="setup-paste-row">
            <input
              type="text"
              placeholder="ngrok authtoken (from dashboard.ngrok.com)"
              value={ngrokToken}
              onChange={(e) => setNgrokToken(e.target.value)}
            />
            <ApplyButton onClick={() => saveSetting("NGROK_AUTHTOKEN", ngrokToken.trim())} />
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 4: Enable integration */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">4</span>
            {isRunning ? "Server running" : "Enable integration"}
          </div>
          <div className="setup-step-desc">
            {isRunning
              ? <>Server is running.{status?.ngrokUrl && <> ngrok URL: <code>{status.ngrokUrl}</code></>}</>
              : "Enable to start the Twilio server and auto-start on boot."
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

        {/* Step 5: Webhook URL */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">5</span>Configure the Twilio webhook</div>
          <div className="setup-step-desc">
            {webhookUrl ? (
              <>
                In the Twilio console, go to your phone number's configuration.<br />
                Under <strong>Voice & Fax</strong> &rarr; <strong>A Call Comes In</strong>, set:<br />
                <code style={{ userSelect: "all", cursor: "text" }}>{webhookUrl}</code><br />
                Method: <strong>HTTP POST</strong>
              </>
            ) : (
              "Start the server first, then the webhook URL will appear here."
            )}
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 6: Phone number display */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">6</span>Your phone number</div>
          <div className="setup-step-desc">
            {phoneNumbers.length > 0 ? (
              <>
                Call this number to talk to Claude:<br />
                {phoneNumbers.map((n) => (
                  <strong key={n.phoneNumber} style={{ color: "#d4d4d4", fontSize: 16, fontFamily: "SF Mono, Fira Code, monospace", display: "inline-block", marginTop: 4 }}>
                    {n.phoneNumber}
                  </strong>
                ))}
              </>
            ) : accountSid && authToken ? (
              "Fetching phone number..."
            ) : (
              "Set your Account SID and Auth Token to fetch your phone number."
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
 * Small "Apply" button that shows "Saved" briefly after clicking.
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
