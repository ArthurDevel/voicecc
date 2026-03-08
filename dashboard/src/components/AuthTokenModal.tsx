/**
 * Modal for pasting a Claude OAuth token.
 *
 * Guides the user to run `claude setup-token` in their terminal,
 * then paste the resulting token. Saves it to .env via the API
 * and re-checks authentication.
 */

import { useState } from "react";
import { post } from "../api";
import type { ApiError } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface AuthTokenModalProps {
  /** Callback when modal is closed */
  onClose: () => void;
  /** Callback after token is saved and auth is confirmed */
  onAuthenticated: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Modal that accepts a Claude OAuth token and saves it to .env.
 *
 * @param onClose - Called when the modal is dismissed
 * @param onAuthenticated - Called after a valid token is saved
 */
export function AuthTokenModal({ onClose, onAuthenticated }: AuthTokenModalProps) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Close modal when clicking the overlay background */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  /** Save token to .env and re-check auth */
  const handleSave = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;

    setSaving(true);
    setError(null);

    try {
      const result = await post<{ authenticated: boolean }>("/api/auth/token", { token: trimmed });
      if (result.authenticated) {
        onAuthenticated();
        onClose();
      } else {
        setError("Token was saved but authentication failed. Check that the token is valid.");
      }
    } catch (err) {
      const message = (err as ApiError)?.message || "Failed to save token";
      setError(message);
    }

    setSaving(false);
  };

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal" style={{ width: 500 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Authenticate with Claude</h2>

        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16, lineHeight: 1.5 }}>
          <p style={{ marginBottom: 12 }}>
            Run the following command in your terminal to generate a token:
          </p>
          <code style={{
            display: "block",
            background: "var(--bg-main)",
            border: "1px solid var(--border-color)",
            padding: "8px 12px",
            fontFamily: '"SF Mono", "Fira Code", monospace',
            fontSize: 12,
            color: "var(--accent-color)",
            marginBottom: 12,
          }}>
            claude setup-token
          </code>
          <p>
            Complete the sign-in in your browser, then paste the token below.
          </p>
        </div>

        <input
          type="password"
          placeholder="sk-ant-oat01-..."
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          style={{
            width: "100%",
            padding: "8px 10px",
            fontSize: 13,
            fontFamily: '"SF Mono", "Fira Code", monospace',
            background: "var(--bg-main)",
            border: "1px solid var(--border-color)",
            color: "var(--text-primary)",
            boxSizing: "border-box",
          }}
        />

        {error && (
          <p style={{ fontSize: 12, color: "#d73a49", marginTop: 8 }}>{error}</p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              background: "var(--btn-secondary-bg)",
              color: "var(--btn-secondary-text)",
              border: "1px solid var(--btn-secondary-border)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !token.trim()}
          >
            {saving ? "Saving..." : "Save token"}
          </button>
        </div>
      </div>
    </div>
  );
}
