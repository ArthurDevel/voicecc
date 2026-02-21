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
  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column" }}>
      <div className="page-header" style={{ padding: "48px 64px 24px" }}>
        <div>
          <h1>Conversation</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Select a conversation from the sidebar.</p>
        </div>
      </div>
      <div className="conversation-messages" style={{ padding: "0 64px 48px" }}>
      </div>
    </div>
  );
}
