/**
 * Conversation message viewer with chat bubbles and inline tool call lines.
 *
 * Fetches messages for a given session ID and renders them as user/assistant
 * chat bubbles with timestamps. Tool calls appear as compact clickable lines
 * that open a detail modal with input and output.
 */

import { useState, useEffect, useRef } from "react";
import { get } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface ConversationViewProps {
  sessionId: string;
  agentId?: string;
}

interface ConversationMessage {
  role: "user" | "assistant" | "tool_use" | "subagent";
  content: string;
  timestamp: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolIsError?: boolean;
  subagentDescription?: string;
  subagentType?: string;
  subagentPrompt?: string;
  subagentResult?: string;
}

interface ToolModalData {
  toolName: string;
  toolInput: string;
  toolResult?: string;
  toolIsError?: boolean;
}

interface SubagentModalData {
  description: string;
  type?: string;
  prompt?: string;
  result?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Short human-readable labels for common tool names */
const TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Edit: "Edit",
  Write: "Write",
  Bash: "Bash",
  Glob: "Glob",
  Grep: "Grep",
  WebSearch: "WebSearch",
  WebFetch: "WebFetch",
};

// ============================================================================
// COMPONENTS
// ============================================================================

/**
 * Build a short summary string for a tool call (shown on the inline line).
 *
 * @param toolName - Name of the tool
 * @param toolInput - JSON-stringified tool input
 * @returns A concise summary like "Read /path/to/file" or "Bash: ls -la"
 */
function buildToolSummary(toolName: string, toolInput: string): string {
  const label = TOOL_LABELS[toolName] || toolName;
  try {
    const input = JSON.parse(toolInput);
    if (toolName === "Read" && input.file_path) {
      return `${label} ${input.file_path}`;
    }
    if (toolName === "Bash" && input.description) {
      return `${label}: ${input.description}`;
    }
    if (toolName === "Bash" && input.command) {
      const cmd = input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
      return `${label}: ${cmd}`;
    }
    if (toolName === "Edit" && input.file_path) {
      return `${label} ${input.file_path}`;
    }
    if (toolName === "Write" && input.file_path) {
      return `${label} ${input.file_path}`;
    }
    if (toolName === "Grep" && input.pattern) {
      return `${label}: ${input.pattern}`;
    }
    if (toolName === "Glob" && input.pattern) {
      return `${label}: ${input.pattern}`;
    }
  } catch {
    // Fall through to default
  }
  return label;
}

/** Modal overlay showing tool call input and output */
function ToolModal({ data, onClose }: { data: ToolModalData; onClose: () => void }) {
  return (
    <div className="tool-modal-overlay" onClick={onClose}>
      <div className="tool-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tool-modal-header">
          <span className="tool-modal-title">{data.toolName}</span>
          <button className="tool-modal-close" onClick={onClose}>x</button>
        </div>
        <div className="tool-modal-section">
          <div className="tool-modal-label">Input</div>
          <pre className="tool-modal-code">{data.toolInput}</pre>
        </div>
        {data.toolResult !== undefined && (
          <div className="tool-modal-section">
            <div className="tool-modal-label">
              Output{data.toolIsError ? " (error)" : ""}
            </div>
            <pre className={`tool-modal-code${data.toolIsError ? " tool-modal-error" : ""}`}>
              {data.toolResult}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

/** Modal overlay showing subagent prompt and response */
function SubagentModal({ data, onClose }: { data: SubagentModalData; onClose: () => void }) {
  return (
    <div className="tool-modal-overlay" onClick={onClose}>
      <div className="tool-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tool-modal-header">
          <span className="tool-modal-title">
            Subagent{data.type ? ` (${data.type})` : ""}
          </span>
          <button className="tool-modal-close" onClick={onClose}>x</button>
        </div>
        {data.prompt && (
          <div className="tool-modal-section">
            <div className="tool-modal-label">Prompt</div>
            <pre className="tool-modal-code">{data.prompt}</pre>
          </div>
        )}
        {data.result && (
          <div className="tool-modal-section">
            <div className="tool-modal-label">Response</div>
            <pre className="tool-modal-code">{data.result}</pre>
          </div>
        )}
      </div>
    </div>
  );
}

export function ConversationView({ sessionId, agentId }: ConversationViewProps) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [title, setTitle] = useState("Loading...");
  const [error, setError] = useState<string | null>(null);
  const [modalData, setModalData] = useState<ToolModalData | null>(null);
  const [subagentModalData, setSubagentModalData] = useState<SubagentModalData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch messages when sessionId or agentId changes
  useEffect(() => {
    setTitle("Loading...");
    setError(null);
    setMessages([]);

    const query = agentId ? `?agentId=${agentId}` : "";
    get<ConversationMessage[]>(`/api/conversations/${sessionId}${query}`)
      .then((msgs) => {
        setMessages(msgs);
        const prefix = agentId ? `[${agentId}] ` : "";
        setTitle(`${prefix}Conversation (${msgs.length} messages)`);
      })
      .catch(() => {
        setError("Error loading conversation.");
        setTitle("Conversation");
      });
  }, [sessionId, agentId]);

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Open the tool detail modal */
  function handleToolClick(msg: ConversationMessage) {
    if (msg.toolName && msg.toolInput) {
      setModalData({
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        toolResult: msg.toolResult,
        toolIsError: msg.toolIsError,
      });
    }
  }

  /** Open the subagent detail modal */
  function handleSubagentClick(msg: ConversationMessage) {
    setSubagentModalData({
      description: msg.subagentDescription || "Subagent",
      type: msg.subagentType,
      prompt: msg.subagentPrompt,
      result: msg.subagentResult,
    });
  }

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <>
      <div className="page-header" style={{ padding: "48px 64px 24px" }}>
        <div>
          <h1>{title}</h1>
        </div>
      </div>
      <div className="conversation-messages" ref={containerRef} style={{ padding: "0 64px 48px" }}>
        {error && <div className="conversation-empty">{error}</div>}
        {!error && messages.length === 0 && !title.includes("Loading") && (
          <div className="conversation-empty">No messages in this session.</div>
        )}
        {messages.map((msg, i) => {
          if (msg.role === "tool_use") {
            return (
              <div
                key={i}
                className="tool-call-line"
                onClick={() => handleToolClick(msg)}
                title="Click to view details"
              >
                <span className="tool-call-icon">&gt;</span>
                <span className="tool-call-summary">
                  {buildToolSummary(msg.toolName || "", msg.toolInput || "{}")}
                </span>
                {msg.toolIsError && <span className="tool-call-error-badge">err</span>}
              </div>
            );
          }

          if (msg.role === "subagent") {
            return (
              <div
                key={i}
                className="subagent-line"
                onClick={() => handleSubagentClick(msg)}
                title="Click to view subagent details"
              >
                <span className="subagent-icon">&lt;/&gt;</span>
                <span className="subagent-summary">
                  {msg.subagentType ? `${msg.subagentType}: ` : ""}{msg.subagentDescription || "Subagent"}
                </span>
                {!msg.subagentResult && <span className="subagent-pending-badge">pending</span>}
              </div>
            );
          }

          return (
            <div key={i} className={`msg msg-${msg.role}`}>
              <div className="msg-header">
                <span className="msg-role">{msg.role === "user" ? "User" : "VoiceCC"}</span>
                <span className="msg-time">{new Date(msg.timestamp).toLocaleTimeString()}</span>
              </div>
              <div className="msg-content">
                {msg.content}
              </div>
            </div>
          );
        })}
      </div>

      {modalData && <ToolModal data={modalData} onClose={() => setModalData(null)} />}
      {subagentModalData && <SubagentModal data={subagentModalData} onClose={() => setSubagentModalData(null)} />}
    </>
  );
}
