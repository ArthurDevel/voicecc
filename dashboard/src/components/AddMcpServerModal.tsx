/**
 * Modal for adding MCP servers, with two tabs:
 *
 * - "claude.ai" (recommended): Links to claude.ai/settings/connectors where
 *   users manage cloud-synced MCP servers. These auto-sync to Claude Code.
 * - "Local": The existing catalog of MCP server presets that are added locally
 *   via `claude mcp add`.
 */

import { useState } from "react";
import { post } from "../api";
import type { ApiError } from "../api";
import { MCP_SERVER_CATALOG } from "../data/mcpServerCatalog";
import type { McpServerPreset } from "../data/mcpServerCatalog";
import { Toast } from "./Toast";

// ============================================================================
// TYPES
// ============================================================================

type Tab = "claudeai" | "local";

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth" | "pending" | "disabled";
  scope: "project" | "user" | "local" | "claudeai" | "managed";
}

interface AddMcpServerModalProps {
  /** Currently installed MCP servers. null = still loading. */
  servers: McpServerEntry[] | null;
  /** Callback to close the modal */
  onClose: () => void;
  /** Callback after a server is added (to refresh the parent list) */
  onAdded: () => Promise<void>;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function AddMcpServerModal({ servers, onClose, onAdded }: AddMcpServerModalProps) {
  const [activeTab, setActiveTab] = useState<Tab>("claudeai");
  const [addingName, setAddingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loading = servers === null;

  /** Find the installed server entry matching a preset URL */
  const findInstalled = (url: string): McpServerEntry | undefined =>
    servers?.find((s) => s.url === url);

  /** Close modal when clicking the overlay background */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  /** Add a server preset, then refresh the parent list */
  const handleAdd = async (preset: McpServerPreset) => {
    setAddingName(preset.name);
    try {
      await post("/api/mcp-servers/add", {
        name: preset.name,
        url: preset.url,
        transport: preset.transport,
        scope: "user",
      });
      await onAdded();
    } catch (err) {
      const message = (err as ApiError)?.message || "Failed to add server";
      setError(message);
    }
    setAddingName(null);
  };

  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal" style={{ width: 620 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Add MCP Server</h2>

        {/* Tabs */}
        <div className="mcp-add-tabs">
          <button
            className={`mcp-add-tab${activeTab === "claudeai" ? " active" : ""}`}
            onClick={() => setActiveTab("claudeai")}
          >
            claude.ai<span className="mcp-tab-rec">Recommended</span>
          </button>
          <button
            className={`mcp-add-tab${activeTab === "local" ? " active" : ""}`}
            onClick={() => setActiveTab("local")}
          >
            Local
          </button>
        </div>

        {/* Tab content: claude.ai */}
        {activeTab === "claudeai" && (
          <div className="mcp-add-claudeai">
            <p>
              Add MCP servers through your claude.ai account. Servers added there
              automatically sync to Claude Code -- no local configuration needed.
            </p>
            <a
              className="mcp-add-claudeai-link"
              href="https://claude.ai/settings/connectors"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open claude.ai Connectors &#8599;
            </a>
          </div>
        )}

        {/* Tab content: Local catalog */}
        {activeTab === "local" && (
          <>
            <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
              Select a server to add locally. Authentication is handled automatically via your browser.
            </p>
            <div className="mcp-add-grid">
              {MCP_SERVER_CATALOG.map((preset) => {
                const installed = findInstalled(preset.url);
                const needsAuth = installed?.status === "needs_auth";
                const isConnected = installed?.status === "connected";
                const isAdding = addingName === preset.name;

                return (
                  <div key={preset.url} className={`mcp-add-card${isConnected ? " installed" : ""}`}>
                    <div className="mcp-add-card-header">
                      <span className="mcp-add-card-name">{preset.name}</span>
                      {isConnected && <span className="mcp-add-card-badge">Installed</span>}
                      {needsAuth && <span className="mcp-add-card-badge needs-auth">Needs authentication</span>}
                    </div>
                    <p className="mcp-add-card-desc">{preset.description}</p>
                    <div className="mcp-add-card-footer">
                      <span className="mcp-add-card-url">{preset.url}</span>
                      {loading ? (
                        <span style={{ fontSize: 11, color: "var(--text-secondary)" }}>Loading...</span>
                      ) : !installed && (
                        <button
                          className="mcp-add-card-btn"
                          disabled={isAdding}
                          onClick={() => handleAdd(preset)}
                        >
                          {isAdding ? "Adding..." : "Add"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <Toast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
