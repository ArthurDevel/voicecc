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

  // Load conversations on mount
  useEffect(() => {
    get<ConversationSummary[]>("/api/conversations")
      .then(setConversations)
      .catch(() => {});
  }, []);

  /** Start the voice sidecar via Terminal.app */
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

  /** Format a conversation label for the sidebar */
  const formatLabel = (conv: ConversationSummary): string => {
    const date = new Date(conv.timestamp);
    const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const preview = conv.firstMessage.slice(0, 40);
    return `${dateStr} - ${preview}`;
  };

  return (
    <div className="sidebar">
      <div className="sidebar-nav">
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
        <div className="sidebar-section-label">Conversations</div>
        <div>
          {conversations.length === 0 && (
            <div style={{ padding: "6px 16px", fontSize: 12, color: "#555" }}>No conversations yet.</div>
          )}
          {conversations.map((conv) => (
            <button
              key={conv.sessionId}
              className={`sidebar-conversation ${selectedConversationId === conv.sessionId ? "active" : ""}`}
              title={conv.firstMessage}
              onClick={() => onSelectConversation(conv.sessionId)}
            >
              {formatLabel(conv)}
            </button>
          ))}
        </div>
      </div>
      <div className="sidebar-footer">
        <button
          className={`sidebar-item ${activePage === "settings" ? "active" : ""}`}
          onClick={() => onPageChange("settings")}
        >
          Settings
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
