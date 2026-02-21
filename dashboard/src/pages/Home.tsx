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

  const [activeTab, setActiveTab] = useState<"general" | "integrations" | "system">("general");

  const tabStyle = (tab: string) => ({
    padding: "6px 14px",
    background: activeTab === tab ? "var(--btn-primary-bg)" : "var(--bg-main)",
    border: "1px solid " + (activeTab === tab ? "transparent" : "var(--border-color)"),
    borderRadius: "0",
    color: activeTab === tab ? "var(--btn-primary-text)" : "var(--text-primary)",
    fontWeight: 500,
    cursor: "pointer",
    fontSize: "13px",
    transition: "all 0.1s ease",
  });

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
          <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
            {/* Tabs Row */}
            <div style={{ display: "flex", gap: "8px", padding: "24px 32px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
              <button style={tabStyle("general")} onClick={() => setActiveTab("general")}>General</button>
              <button style={tabStyle("integrations")} onClick={() => setActiveTab("integrations")}>Integrations & MCP</button>
              <button style={tabStyle("system")} onClick={() => setActiveTab("system")}>System Prompt</button>
            </div>

            {/* Scrollable Content Area */}
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 32px" }}>
              {activeTab === "general" && (
                <SettingsPanel ngrokRunning={ngrokStatus.running} twilioRunning={twilioStatus.running} />
              )}
              {activeTab === "integrations" && (
                <McpServersPanel ngrokRunning={ngrokStatus.running} twilioRunning={twilioStatus.running} />
              )}
              {activeTab === "system" && (
                <ClaudeMdEditor />
              )}
            </div>
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
