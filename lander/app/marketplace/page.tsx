// Marketplace page for browsing, searching, uploading, and downloading agents.
// - Fetches agent listings from /api/agents
// - Client-side search filtering by name, description, and tags
// - Upload form for authenticated users (POST to /api/agents/upload)
// - Download and delete actions per agent card
"use client";

import { useState, useEffect, useCallback, FormEvent } from "react";
import Link from "next/link";
import type { MarketplaceAgentMeta } from "@/lib/s3";
import "./marketplace.css";

// ============================================================================
// CONSTANTS
// ============================================================================

const SUCCESS_MESSAGE_DURATION_MS = 3000;
const DEFAULT_VERSION = "1.0.0";

// ============================================================================
// TYPES
// ============================================================================

interface GhUser {
  login: string;
  avatar_url: string;
  name: string | null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads a JSON cookie value by name from document.cookie.
 * @param name - cookie name
 * @returns parsed value or null if not found
 */
function readJsonCookie<T>(name: string): T | null {
  const match = document.cookie
    .split("; ")
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(match.split("=").slice(1).join("=")));
  } catch {
    return null;
  }
}

/**
 * Formats a byte count into a human-readable size string (KB or MB).
 * @param bytes - size in bytes
 * @returns formatted string like "12.3 KB" or "1.5 MB"
 */
function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks if an agent matches a search query against name, description, and tags.
 * @param agent - agent metadata
 * @param query - lowercase search string
 * @returns true if the agent matches
 */
function agentMatchesSearch(
  agent: MarketplaceAgentMeta,
  query: string
): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return (
    agent.name.toLowerCase().includes(lower) ||
    agent.description.toLowerCase().includes(lower) ||
    agent.tags.some((tag) => tag.toLowerCase().includes(lower))
  );
}

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Upload form panel for publishing a new agent zip.
 * @param user - currently logged-in user
 * @param uploading - whether an upload is in progress
 * @param onUpload - callback to handle form submission
 */
function UploadForm({
  user,
  uploading,
  onUpload,
}: {
  user: GhUser;
  uploading: boolean;
  onUpload: (form: FormData) => void;
}) {
  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    onUpload(formData);
  };

  return (
    <div className="uploadPanel">
      <h3>Upload Agent</h3>
      <form onSubmit={handleSubmit}>
        <div className="formField">
          <label htmlFor="upload-file">Zip file</label>
          <input
            id="upload-file"
            name="file"
            type="file"
            accept=".zip"
            required
          />
        </div>
        <div className="formField">
          <label htmlFor="upload-name">Name</label>
          <input
            id="upload-name"
            name="name"
            type="text"
            required
            placeholder="my-agent"
          />
        </div>
        <div className="formField">
          <label htmlFor="upload-description">Description</label>
          <textarea
            id="upload-description"
            name="description"
            required
            placeholder="What does this agent do?"
          />
        </div>
        <div className="formField">
          <label htmlFor="upload-version">Version</label>
          <input
            id="upload-version"
            name="version"
            type="text"
            defaultValue={DEFAULT_VERSION}
          />
        </div>
        <div className="formField">
          <label htmlFor="upload-tags">Tags (comma-separated)</label>
          <input
            id="upload-tags"
            name="tags"
            type="text"
            placeholder="voice, productivity"
          />
        </div>
        <button className="uploadBtn" type="submit" disabled={uploading}>
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </form>
    </div>
  );
}

/**
 * A single agent card displaying metadata and actions.
 * @param agent - agent metadata to display
 * @param currentUser - logged-in user login, or null
 * @param onDelete - callback when delete is confirmed
 */
function AgentCard({
  agent,
  currentUser,
  onDelete,
}: {
  agent: MarketplaceAgentMeta;
  currentUser: string | null;
  onDelete: (id: string) => void;
}) {
  const isOwner = currentUser === agent.author;

  return (
    <div className="agentCard">
      <div className="agentCardHeader">
        <h3>{agent.name}</h3>
        <div className="agentCardActions">
          <a
            className="downloadBtn"
            href={`/api/agents/${agent.id}/download`}
            download
          >
            Download
          </a>
          {isOwner && (
            <button
              className="deleteBtn"
              onClick={() => onDelete(agent.id)}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <div className="agentAuthor">by {agent.author}</div>
      <div className="agentDescription">{agent.description}</div>
      <div className="agentMeta">
        {agent.tags.map((tag) => (
          <span key={tag} className="agentTag">
            {tag}
          </span>
        ))}
        <span className="agentVersion">v{agent.version}</span>
        <span className="agentSize">{formatSize(agent.size)}</span>
      </div>
    </div>
  );
}

// ============================================================================
// RENDER
// ============================================================================

export default function MarketplacePage() {
  const [agents, setAgents] = useState<MarketplaceAgentMeta[]>([]);
  const [search, setSearch] = useState("");
  const [user, setUser] = useState<GhUser | null>(null);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  /** Fetches agent listings from the API. */
  const fetchAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) throw new Error("Failed to fetch agents");
      const data: MarketplaceAgentMeta[] = await res.json();
      setAgents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch agents");
    }
  }, []);

  // Read user from cookie and fetch agents on mount
  useEffect(() => {
    const ghUser = readJsonCookie<GhUser>("gh_user");
    setUser(ghUser);
    fetchAgents();
  }, [fetchAgents]);

  /**
   * Handles agent upload form submission.
   * @param formData - form data containing file and metadata fields
   */
  const handleUpload = useCallback(
    async (formData: FormData) => {
      setUploading(true);
      setError(null);
      setSuccessMessage(null);

      try {
        const res = await fetch("/api/agents/upload", {
          method: "POST",
          body: formData,
          credentials: "include",
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Upload failed (${res.status})`);
        }

        setSuccessMessage("Agent uploaded successfully.");
        setShowUploadForm(false);
        await fetchAgents();

        setTimeout(() => setSuccessMessage(null), SUCCESS_MESSAGE_DURATION_MS);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [fetchAgents]
  );

  /**
   * Handles agent deletion after user confirmation.
   * @param id - the agent ID to delete
   */
  const handleDelete = useCallback(
    async (id: string) => {
      if (!window.confirm("Delete this agent? This cannot be undone.")) return;

      setError(null);
      try {
        const res = await fetch(`/api/agents/${id}`, {
          method: "DELETE",
          credentials: "include",
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Delete failed (${res.status})`);
        }

        await fetchAgents();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Delete failed");
      }
    },
    [fetchAgents]
  );

  const filteredAgents = agents.filter((a) => agentMatchesSearch(a, search));

  return (
    <div className="container">
      <Link href="/" className="backLink">
        &larr; Back to home
      </Link>

      <div className="marketplaceHeader">
        <h1>Marketplace</h1>
        <div className="authStatus">
          {user ? (
            <>
              <span>{user.login}</span>
              <a href="/api/auth/logout">Sign out</a>
            </>
          ) : (
            <a href="/api/auth/github">Sign in with GitHub</a>
          )}
        </div>
      </div>

      <p className="tagline">
        Browse and share community agents for Voice CC.
      </p>

      {error && <div className="errorMessage">{error}</div>}
      {successMessage && (
        <div className="successMessage">{successMessage}</div>
      )}

      <input
        className="searchInput"
        type="text"
        placeholder="Search agents by name, description, or tag..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {user && (
        <>
          <button
            className="uploadToggle"
            onClick={() => setShowUploadForm(!showUploadForm)}
          >
            {showUploadForm ? "Cancel upload" : "+ Upload Agent"}
          </button>
          {showUploadForm && (
            <UploadForm
              user={user}
              uploading={uploading}
              onUpload={handleUpload}
            />
          )}
        </>
      )}

      <div className="section">
        <h2>Agents</h2>
        {filteredAgents.length === 0 ? (
          <div className="noResults">
            {search
              ? "No agents match your search."
              : "No agents published yet."}
          </div>
        ) : (
          <div className="agentGrid">
            {filteredAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                currentUser={user?.login ?? null}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
