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
import { get, post } from "../api";
import { BrowserCallModal } from "./BrowserCallModal";
import type { ActivePage, TwilioStatus } from "../pages/Home";

// ============================================================================
// TYPES
// ============================================================================

interface SidebarProps {
  activePage: ActivePage;
  onPageChange: (page: ActivePage) => void;
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  twilioStatus: TwilioStatus;
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

export function Sidebar({ activePage, onPageChange, selectedConversationId, onSelectConversation, twilioStatus }: SidebarProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [voiceButtonText, setVoiceButtonText] = useState("Start Voice");
  const [voiceDisabled, setVoiceDisabled] = useState(false);
  const [showBrowserCallModal, setShowBrowserCallModal] = useState(false);

  const browserCallEnabled = twilioStatus.running && twilioStatus.webrtcReady && !!twilioStatus.ngrokUrl;

  useEffect(() => {
    get<ConversationSummary[]>("/api/conversations")
      .then(setConversations)
      .catch(() => { });
  }, []);

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
        <button
          className={`sidebar-item ${activePage === "conversation" && !selectedConversationId ? "active" : ""}`}
          onClick={() => { onPageChange("conversation"); onSelectConversation(""); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>
          Home
        </button>

        <button
          className={`sidebar-item ${activePage === "settings" ? "active" : ""}`}
          onClick={() => onPageChange("settings")}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          Settings
        </button>

        <div className="sidebar-section-label" style={{ marginTop: 16, flexShrink: 0 }}>History</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, overflowY: "auto" }}>
          {conversations.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: 13, color: "var(--text-secondary)" }}>No history yet.</div>
          )}
          {conversations.map((conv) => (
            <button
              key={conv.sessionId}
              className={`sidebar-conversation ${selectedConversationId === conv.sessionId ? "active" : ""}`}
              title={conv.firstMessage}
              onClick={() => { onPageChange("conversation"); onSelectConversation(conv.sessionId); }}
            >
              {formatLabel(conv)}
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        {/* Mockup bottom items */}
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
