/**
 * Browser calling page using direct WebSocket + AudioWorklet.
 *
 * Handles the full call lifecycle:
 * - PIN input for device pairing (unchanged)
 * - AudioWorklet + WebSocket initialization for voice audio
 * - Call connect/disconnect
 *
 * States: pairing -> ready -> connecting -> active
 *
 * Responsibilities:
 * - Capture mic audio via getUserMedia + AudioWorkletNode
 * - Resample mic audio (browser rate -> 16kHz) and send over WebSocket
 * - Receive TTS audio (int16 24kHz) over WebSocket, upsample, and play via AudioWorklet
 * - Handle getUserMedia permission denial gracefully
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

/** Server expects mic audio at this sample rate */
const MIC_TARGET_RATE = 16000;

/** Server sends TTS audio at this sample rate */
const SPEAKER_SOURCE_RATE = 24000;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Downsample audio from a higher sample rate to a lower target rate.
 * Uses 3-tap averaging before decimation as a simple low-pass filter.
 *
 * @param input - Float32 PCM samples at the source rate
 * @param fromRate - Source sample rate (e.g. 48000)
 * @param toRate - Target sample rate (e.g. 16000)
 * @returns Float32Array at the target sample rate
 */
function downsampleToTarget(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const outputLen = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const offset = Math.floor(i * ratio);

    // 3-tap average centered on the decimation point
    const s0 = input[offset] ?? 0;
    const s1 = input[offset + 1] ?? 0;
    const s2 = offset > 0 ? (input[offset - 1] ?? 0) : s0;
    output[i] = (s0 + s1 + s2) / 3;
  }

  return output;
}

/**
 * Upsample audio from a lower sample rate to a higher target rate.
 * Uses linear interpolation between samples.
 *
 * @param input - Float32 PCM samples at the source rate
 * @param fromRate - Source sample rate (e.g. 24000)
 * @param toRate - Target sample rate (e.g. 48000)
 * @returns Float32Array at the target sample rate
 */
function upsampleFromTarget(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = toRate / fromRate;
  const outputLen = Math.round(input.length * ratio);
  const output = new Float32Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const srcPos = i / ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = input[srcIndex] ?? 0;
    const s1 = input[Math.min(srcIndex + 1, input.length - 1)] ?? 0;
    output[i] = s0 + frac * (s1 - s0);
  }

  return output;
}

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

  // WebSocket + Audio refs (replaces Twilio refs)
  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

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
    console.log("[Call] submitPairing called, code length:", code.length);
    if (code.length !== PIN_LENGTH) {
      setPairError("Enter all 6 digits");
      return;
    }

    setPairError("");
    try {
      console.log("[Call] POST /api/webrtc/pair ...");
      const data = await post<{ token: string }>("/api/webrtc/pair", { code });
      console.log("[Call] Pairing success, got token");
      deviceTokenRef.current = data.token;
      localStorage.setItem(DEVICE_TOKEN_KEY, data.token);
      setCallState("ready");
    } catch (err) {
      const message = (err as { message?: string })?.message || "Pairing failed";
      console.error("[Call] Pairing failed:", message);
      setPairError(message);
      clearPin();
    }
  }, [getFullPin]);

  // Check existing token or auto-pair from URL code on mount
  useEffect(() => {
    const token = deviceTokenRef.current;
    const urlCode = new URLSearchParams(window.location.search).get("code");
    console.log("[Call] mount: token=%s, urlCode=%s", token ? "present" : "none", urlCode ?? "none");

    // If a pairing code was passed as a URL parameter, auto-submit it
    if (urlCode && urlCode.length === PIN_LENGTH && !token) {
      console.log("[Call] auto-pairing from URL code");
      submitPairing(urlCode);
      return;
    }

    if (!token) {
      console.log("[Call] no token, showing PIN input");
      inputRefs.current[0]?.focus();
      return;
    }

    // Validate existing token
    console.log("[Call] validating existing token...");
    fetch("/api/webrtc/validate", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        console.log("[Call] validate response status:", res.status);
        return res.json();
      })
      .then((data: { valid: boolean }) => {
        console.log("[Call] validate result:", data);
        if (data.valid) {
          setCallState("ready");
        } else {
          localStorage.removeItem(DEVICE_TOKEN_KEY);
          deviceTokenRef.current = "";
          // Fall back to URL code if available
          if (urlCode && urlCode.length === PIN_LENGTH) {
            submitPairing(urlCode);
          } else {
            inputRefs.current[0]?.focus();
          }
        }
      })
      .catch((err) => {
        console.error("[Call] validate error:", err);
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

  // --------------------------------------------------------------------------
  // CALL HANDLERS
  // --------------------------------------------------------------------------

  /** Clean up all audio resources and WebSocket */
  const cleanup = useCallback(() => {
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }

    // Stop mic tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    // Disconnect worklet node
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  /** Start a call using AudioWorklet + WebSocket */
  const startCall = useCallback(async () => {
    setCallError("");
    setCallState("connecting");

    let audioContext: AudioContext | null = null;

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

      // Create AudioContext and resume (browser autoplay policy requires user gesture)
      audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const browserSampleRate = audioContext.sampleRate;

      // Load AudioWorklet processor
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      // Create worklet node and connect audio graph
      const workletNode = new AudioWorkletNode(audioContext, "audio-processor");
      workletNodeRef.current = workletNode;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(workletNode);
      workletNode.connect(audioContext.destination);

      // Open WebSocket
      const wsProtocol = window.location.protocol === "http:" ? "ws:" : "wss:";
      const wsUrl = `${wsProtocol}//${window.location.host}/audio?token=${deviceTokenRef.current}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Mic audio from worklet -> resample -> send over WebSocket
      workletNode.port.onmessage = (event: MessageEvent) => {
        if (event.data.type !== "audio" || ws.readyState !== WebSocket.OPEN) return;

        const samples: Float32Array = event.data.samples;
        const downsampled = downsampleToTarget(samples, browserSampleRate, MIC_TARGET_RATE);

        // Send as raw float32 binary
        ws.send(downsampled.buffer);
      };

      // Receive audio/control from server
      ws.onmessage = async (event: MessageEvent) => {
        // Binary message: int16 24kHz PCM from TTS
        if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          const int16Samples = new Int16Array(arrayBuffer);

          // Convert int16 to float32 (-1.0 to 1.0)
          const float32Samples = new Float32Array(int16Samples.length);
          for (let i = 0; i < int16Samples.length; i++) {
            float32Samples[i] = int16Samples[i] / 32768;
          }

          // Upsample from 24kHz to browser sample rate
          const upsampled = upsampleFromTarget(float32Samples, SPEAKER_SOURCE_RATE, browserSampleRate);

          // Send to worklet for playback
          workletNode.port.postMessage({ type: "playback", samples: upsampled });
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          const int16Samples = new Int16Array(event.data);

          const float32Samples = new Float32Array(int16Samples.length);
          for (let i = 0; i < int16Samples.length; i++) {
            float32Samples[i] = int16Samples[i] / 32768;
          }

          const upsampled = upsampleFromTarget(float32Samples, SPEAKER_SOURCE_RATE, browserSampleRate);
          workletNode.port.postMessage({ type: "playback", samples: upsampled });
          return;
        }

        // Text message: JSON control signal
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "clear") {
              workletNode.port.postMessage({ type: "clear" });
            }
          } catch {
            // Ignore non-JSON text messages
          }
        }
      };

      ws.onopen = () => {
        console.log("[Call] WebSocket connected");
        setCallState("active");
      };

      ws.onclose = (ev) => {
        console.log("[Call] WebSocket closed, code:", ev.code, "reason:", ev.reason);
        cleanup();
        setCallState("ready");
      };

      ws.onerror = (ev) => {
        console.error("[Call] WebSocket error:", ev);
        setCallError("WebSocket connection failed");
        cleanup();
        setCallState("ready");
      };
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
