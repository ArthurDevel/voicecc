/**
 * Browser call modal with QR code and pairing code display.
 *
 * Shows a QR code pointing to the call page URL via ngrok, a 6-digit
 * pairing code with countdown timer, and a regenerate button.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface BrowserCallModalProps {
  ngrokUrl: string;
  onClose: () => void;
}

interface PairingCodeResponse {
  code: string;
  expiresAt: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function BrowserCallModal({ ngrokUrl, onClose }: BrowserCallModalProps) {
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [countdown, setCountdown] = useState("");
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const callPageUrl = code ? `${ngrokUrl}/call?code=${code}` : `${ngrokUrl}/call`;

  /** Generate a new pairing code */
  const generateCode = useCallback(async () => {
    setCode(null);
    setCountdown("");
    setError(null);

    try {
      const data = await post<PairingCodeResponse>("/api/webrtc/generate-code");
      setCode(data.code);
      setExpiresAt(data.expiresAt);
    } catch (err) {
      const message = err instanceof Error ? err.message : (err as { message?: string })?.message || "Failed to generate code";
      setError(message);
    }
  }, []);

  // Generate code on mount
  useEffect(() => {
    generateCode();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [generateCode]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt) return;

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
  }, [expiresAt]);

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

        <div className="pairing-code" style={{ opacity: isExpired ? 0.4 : 1 }}>
          {error ? "Error" : formattedCode}
        </div>
        <div className="pairing-countdown">
          {error || countdown}
        </div>

        <button className="btn-regenerate" onClick={generateCode}>
          Regenerate Code
        </button>
      </div>
    </div>
  );
}
