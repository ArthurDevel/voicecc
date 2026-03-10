/**
 * Dashboard sidebar with navigation and conversation list.
 *
 * Renders:
 * - Conversation list fetched from API
 * - Settings nav item in footer
 */

import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { get } from "../api";
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
  agentId?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function Sidebar({ twilioStatus, authStatus }: SidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);

  const location = useLocation();

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

  const timeAgo = (timestamp: string): string => {
    const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}m ago`;
    const years = Math.floor(months / 12);
    return `${years}y ago`;
  };

  const formatPreview = (conv: ConversationSummary): string => {
    return conv.firstMessage.slice(0, 40);
  };

  return (
    <div className="sidebar">
      {/* App Logo */}
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
          to="/agents"
          className={`sidebar-item ${location.pathname.startsWith("/agents") ? "active" : ""}`}
          style={{ textDecoration: "none", display: "flex", alignItems: "center" }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
          Agents
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
          {conversations.map((conv) => {
            const to = conv.agentId
              ? `/c/${conv.sessionId}?agentId=${conv.agentId}`
              : `/c/${conv.sessionId}`;
            return (
              <Link
                key={`${conv.agentId ?? "main"}-${conv.sessionId}`}
                to={to}
                className={`sidebar-conversation ${location.pathname === `/c/${conv.sessionId}` ? "active" : ""}`}
                title={conv.firstMessage}
                style={{ textDecoration: "none", display: "flex", flexDirection: "column", gap: 2 }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {formatPreview(conv)}
                  </span>
                  <span style={{
                    fontSize: 10,
                    padding: "1px 6px",
                    borderRadius: 9999,
                    background: "var(--bg-tertiary)",
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}>
                    {timeAgo(conv.timestamp)}
                  </span>
                </div>
                {conv.agentId && (
                  <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {conv.agentId}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>

      <div className="sidebar-footer">
        {authStatus === false && (
          <div style={{
            margin: "0 12px 8px",
            padding: "8px 10px",
            fontSize: 12,
            color: "#d73a49",
            background: "var(--bg-tertiary)",
            borderRadius: 6,
            border: "1px solid #d73a49",
          }}>
            Claude not authenticated
          </div>
        )}
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

    </div>
  );
}
