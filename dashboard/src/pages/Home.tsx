/**
 * Main dashboard layout page.
 *
 * Manages active page state (settings vs conversation) and renders:
 * - Sidebar with navigation and conversation list
 * - Content area with either settings panels or conversation viewer
 */

import { useState, useEffect } from "react";
import { get } from "../api";
import { Sidebar } from "../components/Sidebar";
import { SettingsPanel } from "../components/SettingsPanel";
import { McpServersPanel } from "../components/McpServersPanel";
import { ClaudeMdEditor } from "../components/ClaudeMdEditor";
import { ConversationView } from "../components/ConversationView";

// ============================================================================
// TYPES
// ============================================================================

export type ActivePage = "settings" | "conversation";

export interface NgrokStatus {
  running: boolean;
  url: string | null;
}

export interface TwilioStatus {
  running: boolean;
  webrtcReady: boolean;
  ngrokUrl: string | null;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function Home() {
  const [activePage, setActivePage] = useState<ActivePage>("settings");
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [ngrokStatus, setNgrokStatus] = useState<NgrokStatus>({ running: false, url: null });
  const [twilioStatus, setTwilioStatus] = useState<TwilioStatus>({ running: false, webrtcReady: false, ngrokUrl: null });

  useEffect(() => {
    const poll = () => {
      get<NgrokStatus>("/api/ngrok/status").then(setNgrokStatus).catch(() => { });
      get<TwilioStatus>("/api/twilio/status").then(setTwilioStatus).catch(() => { });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, []);

  /** Handle conversation selection from sidebar */
  const handleSelectConversation = (id: string) => {
    setSelectedConversationId(id);
    setActivePage("conversation");
  };

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <Sidebar
        activePage={activePage}
        onPageChange={setActivePage}
        selectedConversationId={selectedConversationId}
        onSelectConversation={handleSelectConversation}
        twilioStatus={twilioStatus}
      />
      <div className="main">
        {activePage === "settings" && (
          <div className="page active" style={{ overflowY: "auto" }}>
            <div className="page-header" style={{ borderBottom: "none", marginBottom: 8 }}>
              <div>
                <h1>Good afternoon</h1>
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Manage your workspace settings and integrations.</p>
              </div>
            </div>
            <SettingsPanel ngrokRunning={ngrokStatus.running} twilioRunning={twilioStatus.running} />
            <McpServersPanel />
            <ClaudeMdEditor />
          </div>
        )}
        {activePage === "conversation" && selectedConversationId && (
          <div className="page active">
            <ConversationView sessionId={selectedConversationId} />
          </div>
        )}
        {activePage === "conversation" && !selectedConversationId && (
          <div className="page active">
            <div className="page-header">
              <h1>Conversation</h1>
            </div>
            <div className="conversation-messages">
              <div className="conversation-empty">Select a conversation from the sidebar.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
