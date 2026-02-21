/**
 * Main dashboard layout page.
 *
 * Manages active page state (settings vs conversation) and renders:
 * - Sidebar with navigation and conversation list
 * - Content area with either settings panels or conversation viewer
 */

import { useState, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { post } from "../api";
import type { LayoutContext } from "../components/Layout";

// ============================================================================
// TYPES
// ============================================================================

export interface NgrokStatus {
  running: boolean;
  url: string | null;
}

export interface TwilioStatus {
  running: boolean;
  webrtcReady: boolean;
  ngrokUrl: string | null;
}

export function Home() {
  const { authStatus } = useOutletContext<LayoutContext>();
  const [loginDisabled, setLoginDisabled] = useState(false);

  const handleLogin = useCallback(async () => {
    setLoginDisabled(true);
    try {
      await post("/api/auth/login");
    } catch {
      // Terminal failed to open
    }
    setLoginDisabled(false);
  }, []);

  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-header" style={{ padding: "48px 64px 24px" }}>
        <div>
          <h1>Conversation</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Select a conversation from the sidebar.</p>
        </div>
      </div>

      <div style={{ padding: "0 64px 48px" }}>
        <div className="settings-panel">
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
            Connect your Claude Code
          </h2>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 20 }}>
            VoiceCC needs an authenticated Claude Code session to work. The check below verifies your local CLI is logged in.
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: authStatus === false ? 16 : 0 }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: authStatus === null ? "#666" : authStatus ? "var(--accent-color)" : "#d73a49",
              flexShrink: 0,
            }} />
            <span style={{
              fontSize: 13,
              color: authStatus === null ? "var(--text-secondary)" : authStatus ? "var(--accent-color)" : "#d73a49",
            }}>
              {authStatus === null
                ? "Checking authentication..."
                : authStatus
                  ? "Claude Code is authenticated"
                  : "Claude Code is not authenticated"}
            </span>
          </div>

          {authStatus === false && (
            <div className="settings-actions">
              <button disabled={loginDisabled} onClick={handleLogin}>
                Open Claude Code
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
