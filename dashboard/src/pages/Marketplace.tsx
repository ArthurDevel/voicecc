/**
 * Marketplace page at /marketplace for browsing community agents.
 *
 * Responsibilities:
 * - Fetches and displays all published marketplace agents
 * - Client-side search/filter by name, description, and tags
 * - Download agent zips via direct link
 * - Install agents by prompting for a local ID and POSTing to the API
 */

import { useState, useEffect } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface MarketplaceAgentMeta {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  publishedAt: string;
  size: number;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format a byte count into a human-readable size string (KB or MB).
 *
 * @param bytes - File size in bytes
 * @returns Formatted string like "1.2 MB" or "450 KB"
 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Check if an agent matches the search query.
 * Matches against name, description, and tags (case-insensitive).
 *
 * @param agent - The marketplace agent metadata
 * @param query - Search string
 * @returns True if agent matches the query
 */
function matchesSearch(agent: MarketplaceAgentMeta, query: string): boolean {
  const q = query.toLowerCase();
  return (
    agent.name.toLowerCase().includes(q) ||
    agent.description.toLowerCase().includes(q) ||
    agent.tags.some((tag) => tag.toLowerCase().includes(q))
  );
}

// ============================================================================
// COMPONENT
// ============================================================================

export function Marketplace() {
  const [agents, setAgents] = useState<MarketplaceAgentMeta[]>([]);
  const [search, setSearch] = useState("");
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Fetch all marketplace agents on mount */
  useEffect(() => {
    get<MarketplaceAgentMeta[]>("/api/marketplace")
      .then(setAgents)
      .catch((err) => {
        const message = (err as { message?: string })?.message || "Failed to load marketplace agents";
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  /**
   * Install a marketplace agent locally.
   * Prompts the user for a local agent ID, then POSTs to /api/marketplace/:id/install.
   *
   * @param agentId - Marketplace agent ID
   */
  const handleInstall = async (agentId: string) => {
    const localId = window.prompt("Enter a local agent ID for this agent:");
    if (!localId) return;

    setInstalling(agentId);
    setError(null);
    try {
      await post(`/api/marketplace/${agentId}/install`, { localId });
      alert(`Agent installed as "${localId}"`);
    } catch (err: unknown) {
      const message = (err as { message?: string })?.message || "Failed to install agent";
      setError(message);
    } finally {
      setInstalling(null);
    }
  };

  const filtered = search.trim()
    ? agents.filter((a) => matchesSearch(a, search.trim()))
    : agents;

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div className="page active" style={{ display: "flex", flexDirection: "column", padding: 0 }}>
      {/* Page Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "24px 32px 16px", borderBottom: "1px solid var(--border-color)", flexShrink: 0 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--text-primary)" }}>Marketplace</h2>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{ margin: "16px 32px 0", padding: "8px 10px", fontSize: 12, color: "#d73a49", background: "var(--bg-tertiary)", borderRadius: 6, border: "1px solid #d73a49" }}>
          {error}
        </div>
      )}

      {/* Scrollable Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 64px 48px" }}>
        {/* Search input */}
        <div style={{ marginBottom: 24 }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents by name, description, or tags..."
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: 13,
              background: "var(--bg-main)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              borderRadius: 0,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Agent cards */}
        <div className="settings-panel" style={{ padding: 0 }}>
          {loading && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>Loading...</div>
          )}

          {!loading && filtered.length === 0 && (
            <div style={{ padding: 20, fontSize: 13, color: "var(--text-secondary)" }}>
              {search.trim() ? "No agents match your search." : "No agents published yet."}
            </div>
          )}

          {filtered.map((agent) => (
            <div
              key={agent.id}
              style={{
                padding: "16px 20px",
                borderBottom: "1px solid var(--border-color)",
              }}
            >
              {/* Top row: name, author, version */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{agent.name}</span>
                  <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>v{agent.version}</span>
                  {agent.author && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>by {agent.author}</span>
                  )}
                </div>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{formatSize(agent.size)}</span>
              </div>

              {/* Description */}
              {agent.description && (
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.4 }}>
                  {agent.description}
                </p>
              )}

              {/* Tags */}
              {agent.tags.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {agent.tags.map((tag) => (
                    <span
                      key={tag}
                      style={{
                        padding: "2px 8px",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        background: "var(--bg-tertiary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: 0,
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 8 }}>
                <a
                  href={`/api/marketplace/${agent.id}/download`}
                  download
                  style={{
                    padding: "4px 12px",
                    background: "var(--bg-main)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border-color)",
                    borderRadius: 0,
                    fontWeight: 500,
                    fontSize: 12,
                    cursor: "pointer",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                >
                  Download
                </a>
                <button
                  onClick={() => handleInstall(agent.id)}
                  disabled={installing === agent.id}
                  style={{
                    padding: "4px 12px",
                    background: "var(--btn-primary-bg)",
                    color: "var(--btn-primary-text)",
                    border: "none",
                    borderRadius: 0,
                    fontWeight: 500,
                    fontSize: 12,
                    cursor: installing === agent.id ? "not-allowed" : "pointer",
                    opacity: installing === agent.id ? 0.6 : 1,
                  }}
                >
                  {installing === agent.id ? "Installing..." : "Install"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
