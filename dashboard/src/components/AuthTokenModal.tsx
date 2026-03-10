/**
 * Authentication modal with two methods:
 *
 * Tab 1: "Login with Claude" -- spawns `claude auth login` on the server,
 *         shows the OAuth URL, and lets the user paste the auth code.
 * Tab 2: "Setup Token" -- manual paste of a `claude setup-token` token.
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

/** Response from POST /api/auth/oauth/start */
interface OAuthStartResponse {
  url: string;
}

/** Response from POST /api/auth/oauth/code */
interface OAuthCodeResponse {
  authenticated: boolean;
  authMethod: string;
  email?: string;
}

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

const recommendedBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--accent-color)",
  background: "color-mix(in srgb, var(--accent-color) 12%, transparent)",
  padding: "2px 6px",
  borderRadius: 4,
  marginLeft: 6,
  verticalAlign: "middle",
};

// ============================================================================
// COMPONENT
// ============================================================================

export function AuthTokenModal({ onClose, onAuthenticated }: AuthTokenModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("oauth");

  // --- OAuth tab state ---
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState("");
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthSubmitting, setOauthSubmitting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // --- Token tab state ---
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  // ---- OAuth flow handlers ----

  /** Start the login flow: spawns `claude auth login` on the server. */
  const handleStartLogin = async () => {
    setOauthLoading(true);
    setOauthError(null);
    setOauthUrl(null);
    setOauthCode("");

    try {
      const result = await post<OAuthStartResponse>("/api/auth/oauth/start");
      setOauthUrl(result.url);
    } catch (err) {
      setOauthError((err as ApiError)?.message || "Failed to start login");
    }

    setOauthLoading(false);
  };

  /** Send the auth code to complete the login. */
  const handleSubmitCode = async () => {
    const trimmed = oauthCode.trim();
    if (!trimmed) return;

    setOauthSubmitting(true);
    setOauthError(null);

    try {
      const result = await post<OAuthCodeResponse>("/api/auth/oauth/code", { code: trimmed });
      if (result.authenticated) {
        onAuthenticated();
        onClose();
      } else {
        setOauthError("Login completed but authentication check failed. Try again.");
      }
    } catch (err) {
      setOauthError((err as ApiError)?.message || "Failed to complete login");
    }

    setOauthSubmitting(false);
  };

  // ---- Token flow handlers ----

  /** Save a manually pasted token. */
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
            Login with Claude<span style={recommendedBadgeStyle}>recommended</span>
          </button>
          <button style={tabStyle(activeTab === "token")} onClick={() => setActiveTab("token")}>
            Setup Token
          </button>
        </div>

        {/* Tab 1: OAuth via CLI */}
        {activeTab === "oauth" && (
          <div>
            {/* Step 1: Start the login flow */}
            {!oauthUrl && (
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                  <p style={{ marginBottom: 12 }}>
                    Sign in with your Claude account. This authenticates the CLI directly,
                    enabling all features including cloud integrations like Gmail, Google Calendar,
                    and Slack.
                  </p>
                </div>
                <div style={footerStyle}>
                  <button style={cancelBtnStyle} onClick={onClose}>Cancel</button>
                  <button onClick={handleStartLogin} disabled={oauthLoading}>
                    {oauthLoading ? "Starting..." : "Start login"}
                  </button>
                </div>
              </div>
            )}

            {/* Step 2: Show URL and code input */}
            {oauthUrl && (
              <div>
                <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                  <p style={{ marginBottom: 12 }}>
                    Open this URL in your browser and sign in:
                  </p>
                  <a
                    href={oauthUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: "block",
                      background: "var(--bg-main)",
                      border: "1px solid var(--border-color)",
                      padding: "8px 12px",
                      fontFamily: '"SF Mono", "Fira Code", monospace',
                      fontSize: 11,
                      color: "var(--accent-color)",
                      marginBottom: 12,
                      wordBreak: "break-all",
                      textDecoration: "none",
                    }}
                  >
                    {oauthUrl}
                  </a>
                  <p style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 16 }}>
                    Click the link to open it in your browser. After signing in, paste the code below.
                  </p>
                </div>

                <input
                  type="text"
                  placeholder="Paste the code here..."
                  value={oauthCode}
                  onChange={(e) => setOauthCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSubmitCode(); }}
                  style={inputStyle}
                  autoFocus
                />

                <div style={footerStyle}>
                  <button style={cancelBtnStyle} onClick={onClose}>Cancel</button>
                  <button onClick={handleSubmitCode} disabled={oauthSubmitting || !oauthCode.trim()}>
                    {oauthSubmitting ? "Authenticating..." : "Submit code"}
                  </button>
                </div>
              </div>
            )}

            {oauthError && (
              <p style={{ fontSize: 12, color: "#d73a49", marginTop: 8 }}>{oauthError}</p>
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
