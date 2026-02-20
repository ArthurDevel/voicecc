/**
 * WebRTC browser calling page.
 *
 * Handles the full call lifecycle:
 * - PIN input for device pairing
 * - Twilio Voice SDK initialization
 * - Call connect/disconnect
 *
 * States: pairing -> ready -> connecting -> active
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { post, get } from "../api";

// ============================================================================
// TYPES
// ============================================================================

type CallState = "pairing" | "ready" | "connecting" | "active";

// ============================================================================
// CONSTANTS
// ============================================================================

const PIN_LENGTH = 6;
const DEVICE_TOKEN_KEY = "claude-voice-device-token";

// ============================================================================
// COMPONENT
// ============================================================================

export function Call() {
  const [callState, setCallState] = useState<CallState>("pairing");
  const [pairError, setPairError] = useState("");
  const [callError, setCallError] = useState("");
  const [pin, setPin] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const deviceTokenRef = useRef(localStorage.getItem(DEVICE_TOKEN_KEY) || "");
  const twilioDeviceRef = useRef<unknown>(null);
  const connectionRef = useRef<unknown>(null);

  // Check existing token on mount
  useEffect(() => {
    const token = deviceTokenRef.current;
    if (!token) {
      inputRefs.current[0]?.focus();
      return;
    }

    // Validate existing token
    fetch("/api/webrtc/validate", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data: { valid: boolean }) => {
        if (data.valid) {
          setCallState("ready");
        } else {
          localStorage.removeItem(DEVICE_TOKEN_KEY);
          deviceTokenRef.current = "";
          inputRefs.current[0]?.focus();
        }
      })
      .catch(() => inputRefs.current[0]?.focus());
  }, []);

  /** Get the full PIN string from current state */
  const getFullPin = useCallback((): string => pin.join(""), [pin]);

  /** Clear all PIN inputs and focus the first */
  const clearPin = () => {
    setPin(Array(PIN_LENGTH).fill(""));
    inputRefs.current[0]?.focus();
  };

  /** Submit the pairing code to the server */
  const submitPairing = useCallback(async (fullPin?: string) => {
    const code = fullPin || getFullPin();
    if (code.length !== PIN_LENGTH) {
      setPairError("Enter all 6 digits");
      return;
    }

    setPairError("");
    try {
      const data = await post<{ token: string }>("/api/webrtc/pair", { code });
      deviceTokenRef.current = data.token;
      localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
      setCallState("ready");
    } catch (err) {
      const message = (err as { message?: string })?.message || "Pairing failed";
      setPairError(message);
      clearPin();
    }
  }, [getFullPin]);

  /** Handle PIN input changes */
  const handlePinInput = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(0, 1);
    const newPin = [...pin];
    newPin[index] = digit;
    setPin(newPin);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all digits entered
    if (digit && newPin.every((d) => d !== "")) {
      submitPairing(newPin.join(""));
    }
  };

  /** Handle backspace to move to previous input */
  const handlePinKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !pin[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  /** Handle paste to distribute digits across inputs */
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, PIN_LENGTH);
    const newPin = [...pin];
    for (let i = 0; i < pasted.length; i++) {
      newPin[i] = pasted[i];
    }
    setPin(newPin);
    if (pasted.length === PIN_LENGTH) {
      submitPairing(pasted);
    } else if (pasted.length > 0) {
      inputRefs.current[Math.min(pasted.length, PIN_LENGTH - 1)]?.focus();
    }
  };

  /** Start a call using the Twilio Voice SDK */
  const startCall = useCallback(async () => {
    setCallError("");
    setCallState("connecting");

    try {
      // Fetch Twilio access token
      const data = await get<{ token: string }>(`/api/twilio/token`);

      // Dynamically import Twilio Voice SDK
      const { Device } = await import("@twilio/voice-sdk");

      const device = new Device(data.token, { logLevel: "error" } as never);
      twilioDeviceRef.current = device;

      device.on("error", (err: Error) => {
        console.error("Device error:", err);
        setCallError(`Device error: ${err.message}`);
        cleanup();
        setCallState("ready");
      });

      await device.register();
      const connection = await device.connect();
      connectionRef.current = connection;

      connection.on("accept", () => {
        setCallState("active");
      });

      connection.on("disconnect", () => {
        cleanup();
        setCallState("ready");
      });

      connection.on("error", (err: Error) => {
        console.error("Call error:", err);
        setCallError(`Call error: ${err.message}`);
        cleanup();
        setCallState("ready");
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setCallError(`Connection failed: ${message}`);
      cleanup();
      setCallState("ready");
    }
  }, []);

  /** Hang up the current call */
  const hangUp = () => {
    const conn = connectionRef.current as { disconnect?: () => void } | null;
    if (conn?.disconnect) conn.disconnect();
    cleanup();
    setCallState("ready");
  };

  /** Clean up Twilio device and connection */
  const cleanup = () => {
    const device = twilioDeviceRef.current as { destroy?: () => void } | null;
    if (device?.destroy) device.destroy();
    twilioDeviceRef.current = null;
    connectionRef.current = null;
  };

  return (
    <div className="call-container">
      <h1>Claude Voice</h1>
      <p className="subtitle">Enter the pairing code shown on the dashboard</p>

      {/* STATE: Pairing */}
      {callState === "pairing" && (
        <div className="call-state">
          <div className="pin-inputs">
            {pin.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handlePinInput(i, e.target.value)}
                onKeyDown={(e) => handlePinKeyDown(i, e)}
                onPaste={i === 0 ? handlePaste : undefined}
              />
            ))}
          </div>
          <button className="btn btn-pair" onClick={() => submitPairing()}>Pair Device</button>
          <div className="error-msg">{pairError}</div>
        </div>
      )}

      {/* STATE: Ready */}
      {callState === "ready" && (
        <div className="call-state">
          <p className="status-msg" style={{ marginBottom: 24 }}>Device paired. Ready to call.</p>
          <button className="btn btn-call" onClick={startCall}>Start Call</button>
          <div className="error-msg">{callError}</div>
        </div>
      )}

      {/* STATE: Connecting */}
      {callState === "connecting" && (
        <div className="call-state">
          <p className="status-msg">Connecting...</p>
        </div>
      )}

      {/* STATE: Active */}
      {callState === "active" && (
        <div className="call-state">
          <div className="pulse-ring" />
          <div className="call-label">Call in progress</div>
          <button className="btn btn-hangup" onClick={hangUp}>Hang Up</button>
        </div>
      )}
    </div>
  );
}
