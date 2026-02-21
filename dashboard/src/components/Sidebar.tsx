/**
 * Dashboard sidebar with navigation, voice button, and conversation list.
 *
 * Renders:
 * - Start Voice button (opens Terminal)
 * - Call via Browser button (enabled when WebRTC is ready)
 * - Conversation list fetched from API
 * - Settings nav item in footer
 *
 * Includes status polling hooks for ngrok and Twilio.
 */

import { useState, useEffect, useCallback } from "react";
import { Link, useLocation } from "react-router-dom";
import { get, post } from "../api";
import { BrowserCallModal } from "./BrowserCallModal";
import type { TwilioStatus } from "../pages/Home";

// ============================================================================
// TYPES
// ============================================================================

interface SidebarProps {
  twilioStatus: TwilioStatus;
  authStatus: boolean | null;
}

interface ConversationSummary {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function Sidebar({ twilioStatus, authStatus }: SidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [voiceButtonText, setVoiceButtonText] = useState("Start Voice");
  const [voiceDisabled, setVoiceDisabled] = useState(false);
  const [showBrowserCallModal, setShowBrowserCallModal] = useState(false);

  const location = useLocation();

  const browserCallEnabled = twilioStatus.running && twilioStatus.webrtcReady && !!twilioStatus.ngrokUrl;

  const [isDark, setIsDark] = useState(() => {
    return localStorage.getItem("theme") === "dark" ||
      (!localStorage.getItem("theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });

  useEffect(() => {
    get<ConversationSummary[]>("/api/conversations")
      .then(setConversations)
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (isDark) {
      document.body.classList.add("dark");
      document.body.classList.remove("light");
      localStorage.setItem("theme", "dark");
    } else {
      document.body.classList.remove("dark");
      document.body.classList.add("light");
      localStorage.setItem("theme", "light");
    }
  }, [isDark]);

  const handleStartVoice = useCallback(async () => {
    setVoiceDisabled(true);
    setVoiceButtonText("Opening Terminal...");
    try {
      await post("/api/voice/start");
      setVoiceButtonText("Start Voice");
    } catch {
      setVoiceButtonText("Error -- retry");
    }
    setVoiceDisabled(false);
  }, []);

  const formatLabel = (conv: ConversationSummary): string => {
    const date = new Date(conv.timestamp);
    const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const preview = conv.firstMessage.slice(0, 30);
    return `${dateStr} - ${preview}`;
  };

  return (
    <div className="sidebar">
      {/* App Logo + Auth status */}
      <div style={{
        padding: "24px 16px 8px 24px",
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}>
        <span style={{
          fontSize: "28px",
          fontWeight: "400",
          fontFamily: "'IBM Plex Serif', serif",
          letterSpacing: "-0.5px",
          color: "var(--text-primary)",
        }}>
          VoiceCC
        </span>
        <span
          title={authStatus === null ? "Checking Claude auth..." : authStatus ? "Claude authenticated" : "Claude not authenticated"}
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: authStatus === null ? "#666" : authStatus ? "var(--accent-color)" : "#d73a49",
            flexShrink: 0,
          }}
        />
      </div>

      {/* Top action buttons styled as primary/secondary */}
      <div style={{ padding: "16px 12px 0" }}>
        <button
          className="btn-start-voice"
          disabled={voiceDisabled}
          onClick={handleStartVoice}
        >
          {voiceButtonText}
        </button>
        <button
          className="btn-browser-call"
          disabled={!browserCallEnabled}
          onClick={() => setShowBrowserCallModal(true)}
        >
          Call via Browser
        </button>
      </div>

      <div className="sidebar-nav">
        {/* Main Navigation to match mockup structure */}
        <Link
          to="/"
          className={`sidebar-item ${location.pathname === "/" ? "active" : ""}`}
          style={{ textDecoration: "none", display: "flex", alignItems: "center" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
          Home
        </Link>

        <Link
          to="/settings"
          className={`sidebar-item ${location.pathname.startsWith("/settings") ? "active" : ""}`}
          style={{ textDecoration: "none", display: "flex", alignItems: "center" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          Settings
        </Link>

        <div className="sidebar-section-label" style={{ marginTop: 16, flexShrink: 0 }}>History</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, overflowY: "auto" }}>
          {conversations.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 13, color: "var(--text-secondary)" }}>No history yet.</div>
          )}
          {conversations.map((conv) => (
            <Link
              key={conv.sessionId}
              to={`/c/${conv.sessionId}`}
              className={`sidebar-conversation ${location.pathname === `/c/${conv.sessionId}` ? "active" : ""}`}
              title={conv.firstMessage}
              style={{ textDecoration: "none", display: "block" }}
            >
              {formatLabel(conv)}
            </Link>
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-item" onClick={() => setIsDark(!isDark)}>
          {isDark ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
          )}
          {isDark ? "Light Mode" : "Dark Mode"}
        </button>
        <button className="sidebar-item" onClick={() => { }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>
          Support
        </button>
      </div>

      {showBrowserCallModal && twilioStatus.ngrokUrl && (
        <BrowserCallModal
          ngrokUrl={twilioStatus.ngrokUrl}
          onClose={() => setShowBrowserCallModal(false)}
        />
      )}
    </div>
  );
}
