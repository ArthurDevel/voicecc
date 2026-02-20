/**
 * Twilio/WebRTC setup modal wizard.
 *
 * Step-by-step modal for configuring Twilio credentials, ngrok,
 * and browser calling (WebRTC). Supports two modes:
 * - "twilio": Full Twilio voice setup (credentials, ngrok, server, webhook, phone number)
 * - "webrtc": Browser calling setup (credentials, ngrok, server, WebRTC enable)
 */

import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface TwilioPanelProps {
  mode: "twilio" | "webrtc";
  onClose: () => void;
}

interface TwilioStatusData {
  running: boolean;
  ngrokUrl: string | null;
  webrtcReady: boolean;
}

interface PhoneNumber {
  phoneNumber: string;
  friendlyName: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TwilioPanel({ mode, onClose }: TwilioPanelProps) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [ngrokToken, setNgrokToken] = useState("");
  const [ngrokInstalled, setNgrokInstalled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<TwilioStatusData | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [actionText, setActionText] = useState("");

  // Load current settings and check ngrok on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        if (data.TWILIO_ACCOUNT_SID) setAccountSid(data.TWILIO_ACCOUNT_SID);
        if (data.TWILIO_AUTH_TOKEN) setAuthToken(data.TWILIO_AUTH_TOKEN);
        if (data.NGROK_AUTHTOKEN) setNgrokToken(data.NGROK_AUTHTOKEN);
      })
      .catch(() => {});

    checkNgrok();
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch phone numbers when status shows credentials are set
  useEffect(() => {
    if (mode === "twilio" && accountSid && authToken) {
      get<{ numbers: PhoneNumber[] }>("/api/twilio/phone-numbers")
        .then((data) => setPhoneNumbers(data.numbers || []))
        .catch(() => {});
    }
  }, [mode, accountSid, authToken]);

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

  /** Save a single setting to .env */
  const saveSetting = useCallback(async (key: string, value: string): Promise<boolean> => {
    try {
      await post("/api/settings", { [key]: value });
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Save credentials and start the Twilio server + ngrok */
  const handleSaveAndStart = useCallback(async () => {
    setActionText("Saving...");
    const payload: Record<string, string> = {};
    if (accountSid.trim()) payload.TWILIO_ACCOUNT_SID = accountSid.trim();
    if (authToken.trim()) payload.TWILIO_AUTH_TOKEN = authToken.trim();
    if (ngrokToken.trim()) payload.NGROK_AUTHTOKEN = ngrokToken.trim();
    if (Object.keys(payload).length > 0) {
      await post("/api/settings", payload);
    }

    setActionText("Starting...");
    try {
      await post("/api/twilio/start");
      pollStatus();
      setActionText("");
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed to start";
      setActionText(message);
      setTimeout(() => setActionText(""), 4000);
    }
  }, [accountSid, authToken, ngrokToken]);

  /** Stop the server */
  const handleStop = useCallback(async () => {
    await post("/api/twilio/stop");
    pollStatus();
  }, []);

  /** Set up WebRTC (create API key + TwiML app) */
  const handleSetupWebrtc = useCallback(async () => {
    setActionText("Setting up...");
    try {
      await post("/api/twilio/setup-webrtc");
      pollStatus();
      setActionText("");
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Setup failed";
      setActionText(message);
      setTimeout(() => setActionText(""), 3000);
    }
  }, []);

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
        <h2>{mode === "twilio" ? "Twilio Voice Setup" : "Browser Calling (WebRTC)"}</h2>

        {/* Step 1: Credentials */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            {mode === "twilio" ? "Create a Twilio account" : "Twilio credentials"}
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

        {mode === "twilio" && (
          <div className="setup-step">
            <div className="setup-step-title"><span className="setup-step-number">2</span>Get a phone number</div>
            <div className="setup-step-desc">
              In the Twilio console, go to <strong>Phone Numbers</strong> &rarr; <strong>Buy a Number</strong>.
              Pick any number with voice capability.
            </div>
          </div>
        )}

        <hr className="setup-divider" />

        {/* ngrok step */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">{mode === "twilio" ? "3" : "2"}</span>
            {mode === "twilio" ? "Install ngrok" : "ngrok"}
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

        {/* Start/Stop step */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">{mode === "twilio" ? "4" : "3"}</span>
            {isRunning ? "Server running" : "Start server"}
          </div>
          <div className="setup-step-desc">
            {isRunning
              ? <>Server is running.{status?.ngrokUrl && <> ngrok URL: <code>{status.ngrokUrl}</code></>}</>
              : "Click below to save your settings and launch the Twilio server + ngrok."
            }
          </div>
          <div className="setup-paste-row">
            {isRunning ? (
              <button style={{ flex: 1, background: "#6e3630" }} onClick={handleStop}>Stop Server</button>
            ) : (
              <button style={{ flex: 1 }} disabled={!!actionText} onClick={handleSaveAndStart}>
                {actionText || "Save Settings & Start Twilio Server"}
              </button>
            )}
          </div>
        </div>

        {/* Twilio-specific: webhook URL + phone number */}
        {mode === "twilio" && (
          <>
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
          </>
        )}

        {/* WebRTC-specific: enable browser calling */}
        {mode === "webrtc" && (
          <>
            <hr className="setup-divider" />
            <div className="setup-step">
              <div className="setup-step-title"><span className="setup-step-number">4</span>Enable browser calling</div>
              <div className="setup-step-desc">
                {status?.webrtcReady
                  ? 'Browser calling is configured. Use the "Call via Browser" button in the sidebar.'
                  : !isRunning
                    ? "Start the server first (step 3), then set up browser calling."
                    : "Auto-creates a Twilio API Key and TwiML Application. No phone number required."
                }
              </div>
              <div className="setup-paste-row">
                {status?.webrtcReady ? (
                  <span style={{ fontSize: 12, color: "#2ea043" }}>Ready</span>
                ) : (
                  <button
                    style={{ flex: 1, background: "#2ea043" }}
                    disabled={!isRunning || !!actionText}
                    onClick={handleSetupWebrtc}
                  >
                    {actionText || "Set Up Browser Calling"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
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
