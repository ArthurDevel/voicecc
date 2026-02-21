/**
 * Modal for adding preloaded MCP servers.
 *
 * Displays a card grid of available MCP server presets. Each card shows:
 * - Server name and description
 * - "Installed" badge if the server URL is already configured
 * - "Needs authentication" badge + Authenticate button if status is needs_auth
 * - Loading state while the server list is still being fetched
 * - "Add" button for servers not yet installed
 *
 * After adding, the server list is refreshed. If the new server needs auth,
 * the card updates to show the "Needs authentication" state.
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

interface McpServerEntry {
  name: string;
  url: string;
  type: "http" | "stdio";
  status: "connected" | "failed" | "needs_auth";
  scope: "project" | "user" | "local";
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

  /** Open Terminal with the auth flow for a server */
  const handleAuth = (serverName: string) => {
    post(`/api/mcp-servers/${serverName}/auth`).catch(() => {});
  };


  return (
    <div className="modal-overlay visible" onClick={handleOverlayClick}>
      <div className="modal" style={{ width: 620 }}>
        <button className="modal-close" onClick={onClose}>&times;</button>
        <h2>Add MCP Server</h2>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 16 }}>
          Select a server to add. Authentication is handled automatically via your browser.
        </p>

        {/* Server cards grid */}
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
                  ) : needsAuth ? (
                    <button
                      className="mcp-add-card-btn auth"
                      onClick={() => handleAuth(installed!.name)}
                    >
                      Authenticate
                    </button>
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
      </div>
      <Toast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
