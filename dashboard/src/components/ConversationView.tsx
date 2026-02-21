/**
 * Conversation message viewer with chat bubbles.
 *
 * Fetches messages for a given session ID and renders them as user/assistant
 * chat bubbles with timestamps. Auto-scrolls to the bottom on load.
 */

import { useState, useEffect, useRef } from "react";
import { get } from "../api";

// ============================================================================
// TYPES
// ============================================================================

interface ConversationViewProps {
  sessionId: string;
}

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function ConversationView({ sessionId }: ConversationViewProps) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [title, setTitle] = useState("Loading...");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch messages when sessionId changes
  useEffect(() => {
    setTitle("Loading...");
    setError(null);
    setMessages([]);

    get<ConversationMessage[]>(`/api/conversations/${sessionId}`)
      .then((msgs) => {
        setMessages(msgs);
        setTitle(`Conversation (${msgs.length} messages)`);
      })
      .catch(() => {
        setError("Error loading conversation.");
        setTitle("Conversation");
      });
  }, [sessionId]);

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages]);

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
        {messages.map((msg, i) => (
          <div key={i} className="msg">
            <div className={msg.role === "user" ? "msg-user" : "msg-assistant"}>
              {msg.content}
            </div>
            <div className="msg-time">
              {new Date(msg.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
