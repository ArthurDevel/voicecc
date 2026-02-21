/**
 * Browser call modal with QR code and pairing code display.
 *
 * Shows a QR code pointing to the call page URL via tunnel, a 6-digit
 * pairing code with countdown timer, and a regenerate button.
 * Polls to detect when the code is consumed and shows a success message.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface BrowserCallModalProps {
  tunnelUrl: string;
  onClose: () => void;
}

interface PairingCodeResponse {
  code: string;
  expiresAt: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function BrowserCallModal({ tunnelUrl, onClose }: BrowserCallModalProps) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [countdown, setCountdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const [warmingUp, setWarmingUp] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const warmupRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const callPageUrl = code ? `${tunnelUrl}/call?code=${code}` : `${tunnelUrl}/call`;

  /** Generate a new pairing code */
  const generateCode = useCallback(async () => {
    setCode(null);
    setCountdown("");
    setError(null);
    setPaired(false);

    try {
      const data = await post<PairingCodeResponse>("/api/webrtc/generate-code");
      setCode(data.code);
      setExpiresAt(data.expiresAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed to generate code";
      setError(message);
    }
  }, []);

  // Generate code on mount + check tunnel warmup
  useEffect(() => {
    generateCode();

    get<{ startedAt: number | null }>("/api/tunnel/status").then((data) => {
      if (data.startedAt) {
        const elapsed = Date.now() - data.startedAt;
        if (elapsed < 60_000) {
          setWarmingUp(true);
          warmupRef.current = setTimeout(() => setWarmingUp(false), 60_000 - elapsed);
        }
      }
    }).catch(() => {});

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
      if (warmupRef.current) clearTimeout(warmupRef.current);
    };
  }, [generateCode]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt || paired) return;

    const update = () => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      if (remaining <= 0) {
        setCountdown("Code expired");
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        return;
      }
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      setCountdown(`Expires in ${mins}:${String(secs).padStart(2, "0")}`);
    };

    update();
    intervalRef.current = setInterval(update, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [expiresAt, paired]);

  // Poll for code consumption
  useEffect(() => {
    if (!code || paired) return;

    pollRef.current = setInterval(async () => {
      try {
        const data = await get<{ active: boolean }>(`/api/webrtc/code-status?code=${code}`);
        if (!data.active && Date.now() < expiresAt) {
          setPaired(true);
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [code, expiresAt, paired]);

  /** Close modal when clicking overlay */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  /** Format pairing code with space in the middle */
  const formattedCode = code ? `${code.slice(0, 3)} ${code.slice(3)}` : "------";
  const isExpired = countdown === "Code expired";

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal" style={{ textAlign: "center" }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Call via Browser</h2>
        <p style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>
          Scan the QR code or open the link on any device, then enter the pairing code.
        </p>

        <div className="qr-container">
          {callPageUrl && <QRCodeSVG value={callPageUrl} size={160} level="M" />}
        </div>

        <div className="call-url">
          <a href={callPageUrl} target="_blank" rel="noreferrer">{callPageUrl}</a>
        </div>

        {warmingUp && (
          <div style={{ fontSize: 11, color: "#d29922", marginBottom: 8 }}>
            Tunnel is warming up — link may take a moment to become reachable
          </div>
        )}

        {paired ? (
          <>
            <div className="pairing-code" style={{ color: "#2ea043" }}>
              Paired
            </div>
            <div className="pairing-countdown" style={{ color: "#2ea043" }}>
              Device connected successfully
            </div>
          </>
        ) : (
          <>
            <div className="pairing-code" style={{ opacity: isExpired ? 0.4 : 1 }}>
              {error ? "Error" : formattedCode}
            </div>
            <div className="pairing-countdown">
              {error || countdown}
            </div>
          </>
        )}

        <button className="btn-regenerate" onClick={generateCode}>
          {paired ? "New Code" : "Regenerate Code"}
        </button>
      </div>
    </div>
  );
}
