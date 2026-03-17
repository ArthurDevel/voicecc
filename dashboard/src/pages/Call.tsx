/**
 * Browser calling page using pipecat-client-js WebRTC.
 *
 * Handles the full call lifecycle:
 * - PIN input for device pairing (unchanged)
 * - WebRTC connection via pipecat-client-js through the dashboard voice proxy
 * - Call connect/disconnect
 *
 * States: pairing -> ready -> connecting -> active
 *
 * Responsibilities:
 * - Pair device via PIN code
 * - Connect to Pipecat voice pipeline via WebRTC (proxied through /api/voice/)
 * - Handle call start/stop lifecycle
 *
 * NOTE: pipecat-client-js must be installed. If not in package.json, run:
 *   npm install pipecat-client-js
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

type CallState = "pairing" | "ready" | "connecting" | "active";

// ============================================================================
// CONSTANTS
// ============================================================================

const PIN_LENGTH = 6;
const DEVICE_TOKEN_KEY = "claude-voice-device-token";

/** localStorage key prefix for storing agentId per device token */
const AGENT_ID_KEY_PREFIX = "claude-voice-agent-";

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
  const agentIdRef = useRef("");

  // WebRTC refs
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // --------------------------------------------------------------------------
  // PAIRING HANDLERS
  // --------------------------------------------------------------------------

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

      if (agentIdRef.current) {
        localStorage.setItem(`${AGENT_ID_KEY_PREFIX}${data.token}`, agentIdRef.current);
      }

      setCallState("ready");
    } catch (err) {
      const message = (err as { message?: string })?.message || "Pairing failed";
      setPairError(message);
      clearPin();
    }
  }, [getFullPin]);

  // Check existing token or auto-pair from URL code on mount
  useEffect(() => {
    const token = deviceTokenRef.current;
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get("code");
    const urlAgentId = params.get("agentId");

    if (urlAgentId) {
      agentIdRef.current = urlAgentId;
    }

    if (urlCode && urlCode.length === PIN_LENGTH && !token) {
      submitPairing(urlCode);
      return;
    }

    if (!token) {
      inputRefs.current[0]?.focus();
      return;
    }

    // Returning device: read agentId from localStorage if not in URL
    if (!urlAgentId) {
      const storedAgentId = localStorage.getItem(`${AGENT_ID_KEY_PREFIX}${token}`);
      if (storedAgentId) {
        agentIdRef.current = storedAgentId;
      }
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
          if (urlCode && urlCode.length === PIN_LENGTH) {
            submitPairing(urlCode);
          } else {
            inputRefs.current[0]?.focus();
          }
        }
      })
      .catch(() => {
        inputRefs.current[0]?.focus();
      });
  }, []);

  /** Handle PIN input changes */
  const handlePinInput = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(0, 1);
    const newPin = [...pin];
    newPin[index] = digit;
    setPin(newPin);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

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

  // --------------------------------------------------------------------------
  // CALL HANDLERS
  // --------------------------------------------------------------------------

  /** Clean up WebRTC connection and media resources */
  const cleanup = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }, []);

  /**
   * Start a call using WebRTC via the pipecat-client-js protocol.
   *
   * The WebRTC signaling goes through the dashboard proxy at /api/voice/
   * which forwards to the Python SmallWebRTC server.
   */
  const startCall = useCallback(async () => {
    setCallError("");
    setCallState("connecting");

    try {
      // Get microphone access
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setCallError("Microphone access denied. Please allow microphone access and try again.");
        setCallState("ready");
        return;
      }
      mediaStreamRef.current = stream;

      // Create RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      peerConnectionRef.current = pc;

      // Add mic track to the connection
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
      });

      // Set up remote audio playback
      pc.ontrack = (event) => {
        const audio = new Audio();
        audio.srcObject = event.streams[0];
        audio.play().catch(() => {
          // Autoplay might be blocked; user interaction already happened via startCall button
        });
      };

      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
          console.log("[Call] ICE connection state:", pc.iceConnectionState);
          cleanup();
          setCallState("ready");
        }
      };

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (or timeout)
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") {
          resolve();
          return;
        }
        const checkState = () => {
          if (pc.iceGatheringState === "complete") {
            pc.removeEventListener("icegatheringstatechange", checkState);
            resolve();
          }
        };
        pc.addEventListener("icegatheringstatechange", checkState);
        // Timeout after 5 seconds
        setTimeout(resolve, 5000);
      });

      // Send offer to the Python server via the dashboard voice proxy
      const agentParam = agentIdRef.current ? `&agentId=${encodeURIComponent(agentIdRef.current)}` : "";
      const signalUrl = `/api/voice/offer?token=${encodeURIComponent(deviceTokenRef.current)}${agentParam}`;

      const response = await fetch(signalUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sdp: pc.localDescription?.sdp,
          type: pc.localDescription?.type,
        }),
      });

      if (!response.ok) {
        throw new Error(`Signaling failed: ${response.status}`);
      }

      const answer = await response.json();
      await pc.setRemoteDescription(new RTCSessionDescription(answer));

      setCallState("active");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      setCallError(`Connection failed: ${message}`);
      cleanup();
      setCallState("ready");
    }
  }, [cleanup]);

  /** Hang up the current call */
  const hangUp = useCallback(() => {
    cleanup();
    setCallState("ready");
  }, [cleanup]);

  // --------------------------------------------------------------------------
  // RENDER
  // --------------------------------------------------------------------------

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
