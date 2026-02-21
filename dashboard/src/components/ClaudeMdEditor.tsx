/**
 * CLAUDE.md textarea editor with load, save, Cmd+S shortcut, and conflict warning.
 *
 * Renders within the settings page:
 * - Loads CLAUDE.md content from API on mount
 * - Saves on button click or Cmd+S / Ctrl+S
 * - Shows a warning if a user-level CLAUDE.md exists
 * - Tracks dirty state for the save button
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { get, post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface StatusData {
  userClaudeMdExists: boolean;
  userClaudeMdPath: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ClaudeMdEditor() {
  const [content, setContent] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  // Load CLAUDE.md and check for user-level conflict on mount
  useEffect(() => {
    get<{ content: string }>("/api/claude-md")
      .then((data) => setContent(data.content))
      .catch(() => setStatusText("Error loading file"));

    get<StatusData>("/api/status")
      .then((data) => {
        if (data.userClaudeMdExists) {
          setWarning(
            `A user-level ${data.userClaudeMdPath} was detected. Its instructions will also apply and may interfere with this project config.`
          );
        }
      })
      .catch(() => { });
  }, []);

  /** Save the editor content to disk */
  const save = useCallback(async () => {
    setStatusText("Saving...");
    try {
      await post("/api/claude-md", { content });
      setIsDirty(false);
      setStatusText("Saved");
      setTimeout(() => setStatusText((prev) => (prev === "Saved" ? "" : prev)), 2000);
    } catch {
      setStatusText("Error saving");
    }
  }, [content]);

  // Cmd+S / Ctrl+S keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty) save();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isDirty, save]);

  /** Handle text changes in the editor */
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setContent(e.target.value);
    setIsDirty(true);
    setStatusText("Modified");
  };

  /** Handle Tab key to insert spaces */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const textarea = editorRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newValue = content.substring(0, start) + "  " + content.substring(end);
      setContent(newValue);
      setIsDirty(true);
      setStatusText("Modified");
      // Restore cursor position after React re-renders
      requestAnimationFrame(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2;
      });
    }
  };

  return (
    <>
      <div className="page-header" style={{ borderBottom: "none", padding: 0, marginBottom: 24 }}>
        <div>
          <h1>System Prompt</h1>
          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>Configure global system instructions for Claude.</p>
        </div>
      </div>
      <div className="settings-panel" style={{ flex: 1, display: "flex", flexDirection: "column", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>Global Instructions</h2>
            <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>Edit the CLAUDE.md file to provide custom instructions.</p>
          </div>
          <div className="toolbar">
            <span id="status" style={{ fontSize: 12, color: "var(--text-secondary)", marginRight: 8 }}>{statusText}</span>
            <button
              disabled={!isDirty}
              onClick={save}
              style={{
                background: "var(--btn-primary-bg)",
                color: "var(--btn-primary-text)",
                border: "none",
                padding: "6px 14px",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 500,
                cursor: isDirty ? "pointer" : "not-allowed",
                opacity: isDirty ? 1 : 0.5
              }}
            >
              Save
            </button>
          </div>
        </div>
        {warning && (
          <div className="warning visible" style={{ borderRadius: 0, marginBottom: 16, border: "1px solid #665500", background: "#fff8c5" }}>{warning}</div>
        )}
        <textarea
          ref={editorRef}
          id="editor"
          spellCheck={false}
          placeholder="Loading..."
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            minHeight: "300px",
            border: "1px solid var(--border-color)",
            borderRadius: "8px",
            background: "var(--bg-main)",
            padding: "16px",
            color: "var(--text-primary)"
          }}
        />
      </div>
    </>
  );
}
