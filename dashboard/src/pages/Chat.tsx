/**
 * Full-page text chat component for conversing with an agent via HTTP POST + SSE.
 *
 * Responsibilities:
 * - Handles device pairing (URL code auto-pair, cached token validation, PIN fallback)
 * - Sends messages via POST /api/chat/send and reads SSE response stream
 * - Renders a scrollable message list with user/assistant bubbles
 * - Manages send-disable during assistant streaming
 * - Captures sessionId from SSE result events for session resume support
 */

import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

type ChatState = "pairing" | "connected" | "error";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: number;
  isStreaming: boolean;
}

interface SseEvent {
  type: "text_delta" | "tool_start" | "tool_end" | "result" | "error";
  content: string;
  toolName?: string;
  sessionId?: string;
}

/** Message shape returned by GET /api/conversations/{sessionId} */
interface ConversationApiMessage {
  role: "user" | "assistant" | "tool_use" | "subagent";
  content: string;
  timestamp: string;
  toolName?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PIN_LENGTH = 6;
const DEVICE_TOKEN_KEY = "claude-voice-device-token";
const AGENT_ID_KEY_PREFIX = "claude-voice-agent-";

// ============================================================================
// COMPONENT
// ============================================================================

export function Chat() {
  const [chatState, setChatState] = useState<ChatState>("pairing");
  const [pairError, setPairError] = useState("");
  const [error, setError] = useState("");
  const [pin, setPin] = useState<string[]>(Array(PIN_LENGTH).fill(""));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const deviceTokenRef = useRef(localStorage.getItem(DEVICE_TOKEN_KEY) || "");
  const agentIdRef = useRef("");
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /** Generate a simple unique ID for messages */
  const generateId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  /** Map conversation API role to ChatMessage role. `tool_use` becomes `tool`. */
  const mapRole = (role: ConversationApiMessage["role"]): ChatMessage["role"] => {
    if (role === "tool_use") return "tool";
    return role as "user" | "assistant";
  };

  /** Scroll the message list to the bottom */
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  // ============================================================================
  // PAIRING HANDLERS
  // ============================================================================

  /** Get the full PIN string from current state */
  const getFullPin = useCallback((): string => pin.join(""), [pin]);

  /** Clear all PIN inputs and focus the first */
  const clearPin = () => {
    setPin(Array(PIN_LENGTH).fill(""));
    inputRefs.current[0]?.focus();
  };

  /**
   * Mark the chat as connected after successful pairing or token validation.
   * No WebSocket needed -- we use HTTP POST + SSE per message.
   */
  const markConnected = useCallback(() => {
    setChatState("connected");
    console.log("[Chat] Connected (HTTP + SSE mode)");
  }, []);

  /**
   * Submit the pairing code to the server.
   *
   * @param fullPin - Optional pre-assembled PIN string
   */
  const submitPairing = useCallback(async (fullPin?: string) => {
    const code = fullPin || getFullPin();
    if (code.length !== PIN_LENGTH) {
      setPairError("Enter all 6 digits");
      return;
    }

    setPairError("");
    try {
      const data = await post<{ token: string }>("/api/webrtc/pair", { code });
      deviceTokenRef.current = data.token;
      localStorage.setItem(DEVICE_TOKEN_KEY, data.token);

      if (agentIdRef.current) {
        localStorage.setItem(`${AGENT_ID_KEY_PREFIX}${data.token}`, agentIdRef.current);
      }

      markConnected();
    } catch (err) {
      const message = (err as { message?: string })?.message || "Pairing failed";
      setPairError(message);
      clearPin();
    }
  }, [getFullPin, markConnected]);

  // Check existing token or auto-pair from URL code on mount
  useEffect(() => {
    const token = deviceTokenRef.current;
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get("code");
    const urlAgentId = params.get("agentId");
    const urlSessionId = params.get("sessionId");

    if (urlAgentId) {
      agentIdRef.current = urlAgentId;
    }

    if (urlSessionId) {
      sessionIdRef.current = urlSessionId;
    }

    // Resume flow: skip pairing when sessionId is in URL (opened from dashboard)
    if (urlSessionId && urlAgentId) {
      if (!token) {
        // Use sessionId as a placeholder token for the resume flow
        deviceTokenRef.current = `resume-${urlSessionId}`;
      }
      markConnected();
      return;
    }

    // Auto-pair from URL code
    if (urlCode && urlCode.length === PIN_LENGTH && !token) {
      submitPairing(urlCode);
      return;
    }

    if (!token) {
      inputRefs.current[0]?.focus();
      return;
    }

    // Restore agentId from localStorage if not in URL
    if (!urlAgentId) {
      const storedAgentId = localStorage.getItem(`${AGENT_ID_KEY_PREFIX}${token}`);
      if (storedAgentId) {
        agentIdRef.current = storedAgentId;
      }
    }

    // Validate existing token
    fetch("/api/webrtc/validate", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data: { valid: boolean }) => {
        if (data.valid) {
          markConnected();
        } else {
          localStorage.removeItem(DEVICE_TOKEN_KEY);
          deviceTokenRef.current = "";
          if (urlCode && urlCode.length === PIN_LENGTH) {
            submitPairing(urlCode);
          } else {
            inputRefs.current[0]?.focus();
          }
        }
      })
      .catch(() => {
        inputRefs.current[0]?.focus();
      });
  }, []);

  // Pre-load conversation history when resuming a session (waits for connected state)
  useEffect(() => {
    if (chatState !== "connected") return;

    const sessionId = sessionIdRef.current;
    const agentId = agentIdRef.current;
    if (!sessionId || !agentId) return;

    let stale = false;
    const controller = new AbortController();

    fetch(`/api/conversations/${sessionId}?agentId=${agentId}`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: ConversationApiMessage[]) => {
        if (stale) return;

        // Only populate if the user hasn't sent a message while we were fetching
        setMessages((prev) => {
          if (prev.length > 0) return prev;

          return data
            .filter((m) => m.role !== "subagent")
            .map((m) => ({
              id: generateId(),
              role: mapRole(m.role),
              content: m.role === "tool_use" ? (m.toolName || "tool") : m.content,
              timestamp: new Date(m.timestamp).getTime(),
              isStreaming: false,
            }));
        });
      })
      .catch((err) => {
        if ((err as Error).name === "AbortError") return;
        console.error("[Chat] Failed to load conversation history:", err);
      });

    return () => {
      stale = true;
      controller.abort();
    };
  }, [chatState]);

  // Close session on tab close / navigation away
  useEffect(() => {
    if (chatState !== "connected") return;

    const handleUnload = () => {
      const token = deviceTokenRef.current;
      if (!token) return;

      const blob = new Blob(
        [JSON.stringify({ token })],
        { type: "application/json" },
      );
      navigator.sendBeacon("/api/chat/close", blob);
    };

    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, [chatState]);

  // Auto-scroll on new messages or tool status changes
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ============================================================================
  // SSE STREAM HANDLER
  // ============================================================================

  /**
   * Handle an incoming SSE event from the server.
   *
   * Splits assistant text into separate messages around tool calls so
   * the user sees: [text] [tool] [text] [tool] ... instead of one blob.
   *
   * @param event - Parsed SSE event
   */
  const handleSseEvent = (event: SseEvent): void => {
    switch (event.type) {
      case "text_delta":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // Append to existing streaming assistant message
          if (last && last.role === "assistant" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + event.content }];
          }
          // Create new assistant message (after a tool call or at start)
          return [...prev, {
            id: generateId(),
            role: "assistant",
            content: event.content,
            timestamp: Date.now(),
            isStreaming: true,
          }];
        });
        break;

      case "tool_start":
        // Finalize current assistant message, then add a tool message
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            updated[updated.length - 1] = { ...last, isStreaming: false };
          }
          updated.push({
            id: generateId(),
            role: "tool",
            content: event.toolName || "tool",
            timestamp: Date.now(),
            isStreaming: true,
          });
          return updated;
        });
        break;

      case "tool_end":
        // Mark the tool message as done
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "tool" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
          }
          return prev;
        });
        break;

      case "result":
        // Store session ID and update URL for resume support
        if (event.sessionId) {
          sessionIdRef.current = event.sessionId;

          const cleanUrl = new URL(window.location.href);
          cleanUrl.search = "";
          if (agentIdRef.current) {
            cleanUrl.searchParams.set("agentId", agentIdRef.current);
          }
          cleanUrl.searchParams.set("sessionId", event.sessionId);
          window.history.replaceState(null, "", cleanUrl.toString());
        }

        // Finalize any remaining streaming message
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
          }
          return prev;
        });
        setIsStreaming(false);
        break;

      case "error":
        setError(event.content);
        setIsStreaming(false);
        break;
    }
  };

  /**
   * Parse SSE data from a text chunk. Handles partial lines across chunks
   * by returning any incomplete trailing data.
   *
   * @param chunk - Raw text chunk from the stream
   * @param buffer - Leftover text from the previous chunk
   * @returns Remaining buffer text (incomplete line)
   */
  const parseSseChunk = (chunk: string, buffer: string): string => {
    const text = buffer + chunk;
    const parts = text.split("\n\n");

    // The last part may be incomplete -- keep it as buffer
    const remaining = parts.pop() ?? "";

    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith("data: ")) continue;

      try {
        const json = trimmed.slice(6); // Remove "data: " prefix
        const event = JSON.parse(json) as SseEvent;
        handleSseEvent(event);
      } catch {
        // Skip malformed SSE events
      }
    }

    return remaining;
  };

  // ============================================================================
  // EVENT HANDLERS
  // ============================================================================

  /** Handle PIN input changes */
  const handlePinInput = (index: number, value: string) => {
    const digit = value.replace(/\D/g, "").slice(0, 1);
    const newPin = [...pin];
    newPin[index] = digit;
    setPin(newPin);

    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    if (digit && newPin.every((d) => d !== "")) {
      submitPairing(newPin.join(""));
    }
  };

  /** Handle backspace to move to previous input */
  const handlePinKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !pin[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  /** Handle paste to distribute digits across inputs */
  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, PIN_LENGTH);
    const newPin = [...pin];
    for (let i = 0; i < pasted.length; i++) {
      newPin[i] = pasted[i];
    }
    setPin(newPin);
    if (pasted.length === PIN_LENGTH) {
      submitPairing(pasted);
    } else if (pasted.length > 0) {
      inputRefs.current[Math.min(pasted.length, PIN_LENGTH - 1)]?.focus();
    }
  };

  /**
   * Send a user message via POST /api/chat/send and read the SSE response.
   *
   * @param text - The message text to send
   */
  const sendMessage = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Add user message to state
    setMessages((prev) => [...prev, {
      id: generateId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      isStreaming: false,
    }]);

    setInputText("");
    setIsStreaming(true);

    try {
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: deviceTokenRef.current,
          agentId: agentIdRef.current || undefined,
          text: trimmed,
          resumeSessionId: sessionIdRef.current || undefined,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: "Request failed" }));
        throw new Error((errorBody as { error?: string }).error || `HTTP ${response.status}`);
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      // Read the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        sseBuffer = parseSseChunk(chunk, sseBuffer);
      }

      // Process any remaining buffer
      if (sseBuffer.trim()) {
        parseSseChunk(sseBuffer + "\n\n", "");
      }

      // Safety net: ensure streaming is reset when the stream ends
      setIsStreaming(false);
      abortControllerRef.current = null;
    } catch (err) {
      // AbortError is expected when the user clicks stop
      if ((err as Error).name === "AbortError") {
        setIsStreaming(false);
        abortControllerRef.current = null;
        return;
      }
      const msg = (err as Error).message || "Failed to send message";
      setError(msg);
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  /**
   * Stop the current streaming response.
   * Tells the server to interrupt Claude, then aborts the client-side fetch.
   */
  const handleStop = async (): Promise<void> => {
    // Tell server to interrupt the Claude session
    fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: deviceTokenRef.current }),
    }).catch(() => { /* best effort */ });

    // Abort the client-side SSE stream
    abortControllerRef.current?.abort();

    // Finalize the last assistant message so it doesn't stay in "streaming" state
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.isStreaming) {
        return [...prev.slice(0, -1), { ...last, isStreaming: false }];
      }
      return prev;
    });

    setIsStreaming(false);
  };

  /** Handle form submission */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(inputText);
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  // Pairing screen
  if (chatState === "pairing") {
    return (
      <div style={styles.container}>
        <div style={styles.pairingContainer}>
          <h1 style={styles.title}>Claude Chat</h1>
          <p style={styles.subtitle}>Enter the pairing code shown on the dashboard</p>
          <div style={styles.pinInputs}>
            {pin.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handlePinInput(i, e.target.value)}
                onKeyDown={(e) => handlePinKeyDown(i, e)}
                onPaste={i === 0 ? handlePaste : undefined}
                style={styles.pinInput}
              />
            ))}
          </div>
          <button onClick={() => submitPairing()} style={styles.pairButton}>Pair Device</button>
          {pairError && <div style={styles.errorText}>{pairError}</div>}
        </div>
      </div>
    );
  }

  // Error screen
  if (chatState === "error") {
    return (
      <div style={styles.container}>
        <div style={styles.pairingContainer}>
          <h1 style={styles.title}>Connection Error</h1>
          <p style={styles.errorText}>{error}</p>
          <button onClick={() => window.location.reload()} style={styles.pairButton}>Retry</button>
        </div>
      </div>
    );
  }

  // Connected chat UI
  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.headerTitle}>
            {agentIdRef.current || "Claude Chat"}
          </h1>
          <span style={styles.connectedBadge}>Connected</span>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={styles.errorBanner}>
          <span>{error}</span>
          <button
            onClick={() => setError("")}
            style={styles.errorDismiss}
          >
            &times;
          </button>
        </div>
      )}

      {/* Messages */}
      <div style={styles.messageList}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg) => {
          // Tool call messages render as a compact status line
          if (msg.role === "tool") {
            return (
              <div key={msg.id} style={styles.messageBubbleWrapper}>
                <div style={styles.toolBubble}>
                  {msg.isStreaming ? `Using ${msg.content}...` : `Used ${msg.content}`}
                </div>
              </div>
            );
          }

          return (
            <div
              key={msg.id}
              style={{
                ...styles.messageBubbleWrapper,
                justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  ...styles.messageBubble,
                  ...(msg.role === "user" ? styles.userBubble : styles.assistantBubble),
                }}
              >
                <div style={{ wordBreak: "break-word" }}>
                  {msg.role === "assistant" ? (
                    <div className="chat-markdown">
                      <Markdown>{msg.content}</Markdown>
                      {msg.isStreaming && <span style={styles.cursor}>|</span>}
                    </div>
                  ) : (
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {msg.content}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} style={styles.inputBar}>
        <input
          ref={textInputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder="Type a message..."
          disabled={false}
          style={styles.textInput}
          autoFocus
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={handleStop}
            style={styles.stopButton}
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!inputText.trim()}
            style={{
              ...styles.sendButton,
              opacity: !inputText.trim() ? 0.5 : 1,
              cursor: !inputText.trim() ? "not-allowed" : "pointer",
            }}
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    background: "var(--bg-main)",
    color: "var(--text-primary)",
  },
  pairingContainer: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: 600,
    margin: 0,
  },
  subtitle: {
    fontSize: 14,
    color: "var(--text-secondary)",
    margin: 0,
  },
  pinInputs: {
    display: "flex",
    gap: 8,
    marginTop: 8,
  },
  pinInput: {
    width: 40,
    height: 48,
    textAlign: "center" as const,
    fontSize: 20,
    fontWeight: 600,
    border: "1px solid var(--border-color)",
    borderRadius: 0,
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
  },
  pairButton: {
    padding: "8px 24px",
    background: "var(--btn-primary-bg)",
    color: "var(--btn-primary-text)",
    border: "none",
    borderRadius: 0,
    fontWeight: 500,
    fontSize: 14,
    cursor: "pointer",
  },
  errorText: {
    fontSize: 13,
    color: "#d73a49",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 20px",
    borderBottom: "1px solid var(--border-color)",
    flexShrink: 0,
  },
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  headerTitle: {
    margin: 0,
    fontSize: 16,
    fontWeight: 600,
  },
  connectedBadge: {
    fontSize: 11,
    fontWeight: 500,
    padding: "2px 8px",
    borderRadius: 10,
    background: "#2ea04333",
    color: "#2ea043",
  },
  messageList: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "16px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  emptyState: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--text-secondary)",
    fontSize: 14,
  },
  messageBubbleWrapper: {
    display: "flex",
  },
  messageBubble: {
    maxWidth: "70%",
    padding: "10px 14px",
    fontSize: 14,
    lineHeight: "1.5",
    borderRadius: 8,
  },
  userBubble: {
    background: "var(--btn-primary-bg)",
    color: "var(--btn-primary-text)",
    borderBottomRightRadius: 2,
  },
  assistantBubble: {
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)",
    borderBottomLeftRadius: 2,
  },
  cursor: {
    opacity: 0.5,
    animation: "blink 1s step-end infinite",
  },
  toolBubble: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontStyle: "italic",
    padding: "6px 12px",
    background: "var(--bg-secondary)",
    border: "1px dashed var(--border-color)",
    borderRadius: 6,
  },
  inputBar: {
    display: "flex",
    gap: 8,
    padding: "12px 20px",
    borderTop: "1px solid var(--border-color)",
    flexShrink: 0,
    background: "var(--bg-main)",
  },
  textInput: {
    flex: 1,
    padding: "10px 14px",
    fontSize: 14,
    border: "1px solid var(--border-color)",
    borderRadius: 0,
    background: "var(--bg-secondary)",
    color: "var(--text-primary)",
    outline: "none",
  },
  sendButton: {
    padding: "10px 20px",
    background: "var(--btn-primary-bg)",
    color: "var(--btn-primary-text)",
    border: "none",
    borderRadius: 0,
    fontWeight: 500,
    fontSize: 14,
  },
  stopButton: {
    padding: "10px 20px",
    background: "#d73a49",
    color: "#ffffff",
    border: "none",
    borderRadius: 0,
    fontWeight: 500,
    fontSize: 14,
    cursor: "pointer",
  },
  errorBanner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 20px",
    background: "#d73a4922",
    borderBottom: "1px solid #d73a4955",
    color: "#d73a49",
    fontSize: 13,
    flexShrink: 0,
  },
  errorDismiss: {
    background: "none",
    border: "none",
    color: "#d73a49",
    fontSize: 18,
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  },
};
