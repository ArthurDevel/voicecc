/**
 * Twilio PSTN voice setup modal wizard.
 *
 * Step-by-step modal for configuring Twilio credentials and phone number
 * for PSTN calling. cloudflared is auto-managed via the npm package. Steps:
 * 1. Create a Twilio account (credentials)
 * 2. Get a phone number
 * 3. Add personal phone number as verified caller
 * 4. Enter your personal phone number
 * 5. Enable integration
 * 6. Test
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
  tunnelUrl: string | null;
}

interface IntegrationsState {
  twilio: { enabled: boolean };
  browserCall: { enabled: boolean };
}

interface TwilioPhoneNumber {
  phoneNumber: string;
  friendlyName: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function TwilioPanel({ onClose }: TwilioPanelProps) {
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [status, setStatus] = useState<TwilioStatusData | null>(null);
  const [actionText, setActionText] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [userPhoneNumber, setUserPhoneNumber] = useState("");
  const [testCallStatus, setTestCallStatus] = useState("");
  const [twilioNumbers, setTwilioNumbers] = useState<TwilioPhoneNumber[]>([]);
  const [selectedTwilioNumber, setSelectedTwilioNumber] = useState("");
  const [loadingNumbers, setLoadingNumbers] = useState(false);

  /** Fetch available phone numbers from the Twilio account */
  const fetchTwilioNumbers = useCallback(async () => {
    setLoadingNumbers(true);
    try {
      const data = await get<{ numbers: TwilioPhoneNumber[] }>("/api/twilio/phone-numbers");
      setTwilioNumbers(data.numbers);
    } catch {
      setTwilioNumbers([]);
    } finally {
      setLoadingNumbers(false);
    }
  }, []);

  // Load current settings, integration state, and check cloudflared on mount
  useEffect(() => {
    get<Record<string, string>>("/api/settings")
      .then((data) => {
        if (data.TWILIO_ACCOUNT_SID) setAccountSid(data.TWILIO_ACCOUNT_SID);
        if (data.TWILIO_AUTH_TOKEN) setAuthToken(data.TWILIO_AUTH_TOKEN);
        if (data.USER_PHONE_NUMBER) setUserPhoneNumber(data.USER_PHONE_NUMBER);
        if (data.TWILIO_PHONE_NUMBER) setSelectedTwilioNumber(data.TWILIO_PHONE_NUMBER);
      })
      .catch(() => {});

    get<IntegrationsState>("/api/integrations")
      .then((data) => setEnabled(data.twilio.enabled))
      .catch(() => {});

    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch Twilio numbers once credentials are available
  useEffect(() => {
    if (accountSid.trim() && authToken.trim()) {
      fetchTwilioNumbers();
    }
  }, [accountSid, authToken, fetchTwilioNumbers]);


  /** Poll Twilio status */
  const pollStatus = () => {
    get<TwilioStatusData>("/api/twilio/status").then(setStatus).catch(() => {});
  };

  /**
   * Save a single setting to .env. If the integration is currently enabled,
   * restart it so the new config takes effect.
   *
   * @param key - The .env key to save
   * @param value - The value to save
   * @returns True if save succeeded
   */
  const saveSetting = useCallback(async (key: string, value: string): Promise<boolean> => {
    try {
      await post("/api/settings", { [key]: value });
      if (enabled) {
        await post("/api/integrations/twilio", { enabled: false });
        await post("/api/integrations/twilio", { enabled: true });
        pollStatus();
      }
      return true;
    } catch {
      return false;
    }
  }, [enabled]);

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
  const canEnable = !!(accountSid.trim() && authToken.trim() && userPhoneNumber.trim() && selectedTwilioNumber.trim());

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal">
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Twilio Voice Setup</h2>

        <div className="setup-warning-banner">
          For now, only Twilio Trial Accounts are supported. Non-trial accounts might work but have not been tested.
        </div>

        <div className="setup-warning-banner">
          Read thoroughly! Twilio requires many steps and it is easy to miss something.
        </div>

        {/* Step 1: Credentials */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">1</span>
            Create a Twilio account
          </div>
          <div className="setup-step-desc">
            Sign up at <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noreferrer">twilio.com/try-twilio</a>.
            Copy your Account SID and Auth Token from the <a href="https://console.twilio.com/" target="_blank" rel="noreferrer">console dashboard</a>.
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
            Pick any number with voice capability. Then select it below.
          </div>
          <div className="setup-paste-row">
            <select
              value={selectedTwilioNumber}
              onChange={(e) => setSelectedTwilioNumber(e.target.value)}
              disabled={!accountSid.trim() || !authToken.trim()}
              style={{ flex: 1 }}
            >
              <option value="">
                {!accountSid.trim() || !authToken.trim()
                  ? "Enter credentials first"
                  : loadingNumbers
                    ? "Loading..."
                    : twilioNumbers.length === 0
                      ? "No numbers found"
                      : "Select a phone number"}
              </option>
              {twilioNumbers.map((n) => (
                <option key={n.phoneNumber} value={n.phoneNumber}>
                  {n.phoneNumber} ({n.friendlyName})
                </option>
              ))}
            </select>
            <button
              onClick={fetchTwilioNumbers}
              disabled={!accountSid.trim() || !authToken.trim() || loadingNumbers}
              title="Refresh phone numbers"
              style={{ minWidth: "auto", padding: "6px 10px" }}
            >
              {loadingNumbers ? "..." : "Refresh"}
            </button>
            <ApplyButton onClick={() => saveSetting("TWILIO_PHONE_NUMBER", selectedTwilioNumber)} />
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 3: Verify personal phone number */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">3</span>Add your personal phone number to Twilio</div>
          <div className="setup-step-desc">
            Add your personal phone number as a verified caller in the Twilio console at{" "}
            <a href="https://console.twilio.com/us1/develop/phone-numbers/manage/verified" target="_blank" rel="noreferrer">
              Verified Caller IDs
            </a>.
            This is required for Twilio to be able to call your phone.
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 4: Enter personal phone number */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">4</span>Enter your personal phone number</div>
          <div className="setup-step-desc">
            Enter the same phone number you verified on Twilio in the previous step.
          </div>
          <div className="setup-paste-row">
            <input
              type="tel"
              placeholder="+1234567890"
              value={userPhoneNumber}
              onChange={(e) => setUserPhoneNumber(e.target.value)}
            />
            <ApplyButton onClick={() => saveSetting("USER_PHONE_NUMBER", userPhoneNumber.trim())} />
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 5: Enable integration */}
        <div className="setup-step">
          <div className="setup-step-title">
            <span className="setup-step-number">5</span>
            {isRunning ? "Server running" : "Enable integration"}
          </div>
          <div className="setup-step-desc">
            {isRunning
              ? <>Server is running.{status?.tunnelUrl && <> Tunnel URL: <code>{status.tunnelUrl}</code></>}</>
              : !canEnable
                ? "Complete all previous steps before enabling."
                : "Enable to start the Twilio server and auto-start on boot."
            }
            {actionText && <div style={{ color: "#d73a49", marginTop: 4, fontSize: 12 }}>{actionText}</div>}
          </div>
          <div className="setup-paste-row">
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: (toggling || !canEnable) ? "not-allowed" : "pointer" }}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={toggling || (!enabled && !canEnable)}
                onChange={handleToggle}
                style={{ width: 16, height: 16, cursor: (toggling || !canEnable) ? "not-allowed" : "pointer" }}
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                {toggling ? (enabled ? "Stopping..." : "Starting...") : "Enabled"}
              </span>
            </label>
          </div>
        </div>

        <hr className="setup-divider" />

        {/* Step 6: Test */}
        <div className="setup-step">
          <div className="setup-step-title"><span className="setup-step-number">6</span>Test your setup</div>
          <div className="setup-step-desc">
            We'll call your personal phone number with a test message.
            {testCallStatus && <div style={{ color: testCallStatus.startsWith("Error") ? "#d73a49" : "#2ea043", marginTop: 4, fontSize: 12 }}>{testCallStatus}</div>}
          </div>
          <div className="setup-paste-row">
            <button
              disabled={!enabled || !userPhoneNumber.trim() || testCallStatus === "Calling..."}
              onClick={async () => {
                setTestCallStatus("Calling...");
                try {
                  await post("/api/twilio/test-call", { to: userPhoneNumber.trim() });
                  setTestCallStatus("Success! Go to an agent and click \"Call via Phone\"!");
                } catch (err) {
                  const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed";
                  setTestCallStatus(`Error: ${message}`);
                }
                setTimeout(() => setTestCallStatus(""), 6000);
              }}
            >
              Test Call
            </button>
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
