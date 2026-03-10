/**
 * Authentication modal with two methods:
 *
 * Tab 1: "Login with Claude" (recommended) -- OAuth PKCE flow via claude.ai.
 *         Enables cloud MCP servers (Gmail, Calendar, Slack, etc.).
 *
 * Tab 2: "Setup Token" -- manual paste of a `claude setup-token` token.
 *         Quick but cloud MCP servers won't be available.
 */

import { useState } from "react";
import { post } from "../api";
import type { ApiError } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface AuthTokenModalProps {
  onClose: () => void;
  onAuthenticated: () => void;
}

type Tab = "oauth" | "token";
type OAuthStep = "idle" | "waiting" | "exchanging";

// ============================================================================
// STYLES
// ============================================================================

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  gap: 0,
  marginBottom: 20,
  borderBottom: "1px solid var(--border-color)",
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  fontSize: 13,
  fontWeight: active ? 600 : 400,
  color: active ? "var(--text-primary)" : "var(--text-secondary)",
  background: "none",
  border: "none",
  borderBottom: active ? "2px solid var(--accent-color)" : "2px solid transparent",
  cursor: "pointer",
  marginBottom: -1,
});

const badgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--accent-color)",
  background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
  padding: "2px 6px",
  borderRadius: 4,
  marginLeft: 6,
  verticalAlign: "middle",
};

const noteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  background: "color-mix(in srgb, var(--warning-color, #f59e0b) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--warning-color, #f59e0b) 20%, transparent)",
  padding: "8px 12px",
  borderRadius: 6,
  marginTop: 12,
  lineHeight: 1.5,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: 13,
  fontFamily: '"SF Mono", "Fira Code", monospace',
  background: "var(--bg-main)",
  border: "1px solid var(--border-color)",
  color: "var(--text-primary)",
  boxSizing: "border-box",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 16,
};

const cancelBtnStyle: React.CSSProperties = {
  background: "var(--btn-secondary-bg)",
  color: "var(--btn-secondary-text)",
  border: "1px solid var(--btn-secondary-border)",
};

// ============================================================================
// COMPONENT
// ============================================================================

export function AuthTokenModal({ onClose, onAuthenticated }: AuthTokenModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");

  // --- OAuth tab state ---
  const [oauthStep, setOauthStep] = useState<OAuthStep>("idle");
  const [oauthCode, setOauthCode] = useState("");
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // --- Token tab state ---
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ---- OAuth flow handlers ----

  const handleOAuthStart = async () => {
    setOauthError(null);
    try {
      const { url, state } = await post<{ url: string; state: string }>("/api/auth/oauth/start");
      setOauthState(state);
      window.open(url, "_blank");
      setOauthStep("waiting");
    } catch (err) {
      setOauthError((err as ApiError)?.message || "Failed to start login");
    }
  };

  const handleOAuthSubmitCode = async () => {
    const trimmed = oauthCode.trim();
    if (!trimmed) return;

    setOauthStep("exchanging");
    setOauthError(null);

    try {
      const result = await post<{ authenticated: boolean }>("/api/auth/oauth/callback", { code: trimmed, state: oauthState });
      if (result.authenticated) {
        onAuthenticated();
        onClose();
      } else {
        setOauthError("Authentication could not be verified. Please try again.");
        setOauthStep("waiting");
      }
    } catch (err) {
      setOauthError((err as ApiError)?.message || "Failed to exchange code");
      setOauthStep("waiting");
    }
  };

  // ---- Token flow handlers ----

  const handleSaveToken = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;

    setSaving(true);
    setTokenError(null);

    try {
      const result = await post<{ authenticated: boolean }>("/api/auth/token", { token: trimmed });
      if (result.authenticated) {
        onAuthenticated();
        onClose();
      } else {
        setTokenError("Token was saved but authentication failed. Check that the token is valid.");
      }
    } catch (err) {
      setTokenError((err as ApiError)?.message || "Failed to save token");
    }

    setSaving(false);
  };

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal" style={{ width: 520 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Authenticate with Claude</h2>

        {/* Tab bar */}
        <div style={tabBarStyle}>
          <button style={tabStyle(activeTab === "oauth")} onClick={() => setActiveTab("oauth")}>
            Login with Claude<span style={badgeStyle}>recommended</span>
          </button>
          <button style={tabStyle(activeTab === "token")} onClick={() => setActiveTab("token")}>
            Setup Token
          </button>
        </div>

        {/* Tab 1: OAuth PKCE */}
        {activeTab === "oauth" && (
          <div>
            {oauthStep === "idle" && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <p style={{ marginBottom: 12 }}>
                  Sign in with your Claude account to authenticate. This enables all features
                  including cloud integrations like Gmail, Google Calendar, and Slack.
                </p>
                <p style={{ marginBottom: 16 }}>
                  A new tab will open for you to authorize access.
                </p>
                {oauthError && (
                  <p style={{ fontSize: 12, color: "#d73a49", marginBottom: 8 }}>{oauthError}</p>
                )}
                <div style={footerStyle}>
                  <button style={cancelBtnStyle} onClick={onClose}>Cancel</button>
                  <button onClick={handleOAuthStart}>Login with Claude</button>
                </div>
              </div>
            )}

            {oauthStep === "waiting" && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                <p style={{ marginBottom: 12 }}>
                  Complete the sign-in in the new tab. Once authorized, you'll see
                  a page with an authorization code.
                </p>
                <p style={{ marginBottom: 16 }}>
                  Copy that code and paste it below:
                </p>
                <input
                  type="text"
                  placeholder="Paste authorization code here..."
                  value={oauthCode}
                  onChange={(e) => setOauthCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleOAuthSubmitCode(); }}
                  autoFocus
                  style={inputStyle}
                />
                {oauthError && (
                  <p style={{ fontSize: 12, color: "#d73a49", marginTop: 8 }}>{oauthError}</p>
                )}
                <div style={footerStyle}>
                  <button style={cancelBtnStyle} onClick={() => { setOauthStep("idle"); setOauthCode(""); setOauthError(null); }}>
                    Back
                  </button>
                  <button onClick={handleOAuthSubmitCode} disabled={!oauthCode.trim()}>
                    Submit code
                  </button>
                </div>
              </div>
            )}

            {oauthStep === "exchanging" && (
              <div style={{ fontSize: 13, color: "var(--text-secondary)", textAlign: "center", padding: "24px 0" }}>
                Authenticating...
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Manual token paste */}
        {activeTab === "token" && (
          <div>
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
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveToken(); }}
              style={inputStyle}
            />

            <div style={noteStyle}>
              Cloud MCP servers (Gmail, Google Calendar, Slack, etc.) will not be available
              with this method. Use "Login with Claude" for full integration support.
            </div>

            {tokenError && (
              <p style={{ fontSize: 12, color: "#d73a49", marginTop: 8 }}>{tokenError}</p>
            )}

            <div style={footerStyle}>
              <button style={cancelBtnStyle} onClick={onClose}>Cancel</button>
              <button onClick={handleSaveToken} disabled={saving || !token.trim()}>
                {saving ? "Saving..." : "Save token"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
