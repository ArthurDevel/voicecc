/**
 * Full-page text chat component for conversing with an agent via WebSocket.
 *
 * Responsibilities:
 * - Handles device pairing (same flow as Call.tsx: URL code auto-pair, cached token validation, PIN fallback)
 * - Opens a WebSocket to /chat-ws for streaming text conversation
 * - Renders a scrollable message list with user/assistant bubbles
 * - Manages send-disable during assistant streaming
 */

import { useState, useRef, useEffect, useCallback } from "react";
import { post } from "../api";

// ============================================================================
// TYPES
// ============================================================================

type ChatState = "pairing" | "connected" | "error";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  isStreaming: boolean;
}

interface WsIncomingMessage {
  type: "text_delta" | "tool_start" | "tool_end" | "result" | "error";
  content: string;
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
  const [toolStatus, setToolStatus] = useState<string | null>(null);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const deviceTokenRef = useRef(localStorage.getItem(DEVICE_TOKEN_KEY) || "");
  const agentIdRef = useRef("");
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);

  // ============================================================================
  // HELPER FUNCTIONS
  // ============================================================================

  /** Generate a simple unique ID for messages */
  const generateId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
   * Open WebSocket connection to the chat server.
   * Constructs ws URL from the current page host.
   */
  const connectWebSocket = useCallback(() => {
    const wsProtocol = window.location.protocol === "http:" ? "ws:" : "wss:";
    const agentParam = agentIdRef.current ? `&agentId=${encodeURIComponent(agentIdRef.current)}` : "";
    const wsUrl = `${wsProtocol}//${window.location.host}/chat-ws?token=${deviceTokenRef.current}${agentParam}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[Chat] WebSocket connected");
      setChatState("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;

      let msg: WsIncomingMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      handleIncoming(msg);
    };

    ws.onclose = (ev) => {
      console.log("[Chat] WebSocket closed, code:", ev.code, "reason:", ev.reason);
      wsRef.current = null;
      if (ev.code !== 1000) {
        setError(`Connection closed: ${ev.reason || "unexpected disconnect"}`);
        setChatState("error");
      }
    };

    ws.onerror = () => {
      console.error("[Chat] WebSocket error");
      setError("WebSocket connection failed");
      setChatState("error");
    };
  }, []);

  /**
   * Handle an incoming WebSocket message from the server.
   *
   * @param msg - Parsed incoming message
   */
  const handleIncoming = (msg: WsIncomingMessage): void => {
    switch (msg.type) {
      case "text_delta":
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          // Append to existing streaming assistant message
          if (last && last.role === "assistant" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, content: last.content + msg.content }];
          }
          // Create new assistant message
          return [...prev, {
            id: generateId(),
            role: "assistant",
            content: msg.content,
            timestamp: Date.now(),
            isStreaming: true,
          }];
        });
        break;

      case "tool_start":
        setToolStatus(`Using ${msg.toolName || "tool"}...`);
        break;

      case "tool_end":
        setToolStatus(null);
        break;

      case "result":
        // Finalize assistant message, re-enable input
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === "assistant" && last.isStreaming) {
            return [...prev.slice(0, -1), { ...last, isStreaming: false }];
          }
          return prev;
        });
        setIsStreaming(false);
        setToolStatus(null);
        break;

      case "error":
        setError(msg.content);
        setIsStreaming(false);
        setToolStatus(null);
        break;
    }
  };

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

      connectWebSocket();
    } catch (err) {
      const message = (err as { message?: string })?.message || "Pairing failed";
      setPairError(message);
      clearPin();
    }
  }, [getFullPin, connectWebSocket]);

  // Check existing token or auto-pair from URL code on mount
  useEffect(() => {
    const token = deviceTokenRef.current;
    const params = new URLSearchParams(window.location.search);
    const urlCode = params.get("code");
    const urlAgentId = params.get("agentId");

    if (urlAgentId) {
      agentIdRef.current = urlAgentId;
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
          connectWebSocket();
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

  // Auto-scroll on new messages or tool status changes
  useEffect(() => {
    scrollToBottom();
  }, [messages, toolStatus]);

  // Clean up WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.close();
        }
        wsRef.current = null;
      }
    };
  }, []);

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
   * Send a user message over the WebSocket.
   *
   * @param text - The message text to send
   */
  const sendMessage = (text: string): void => {
    const trimmed = text.trim();
    if (!trimmed || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Add user message to state
    setMessages((prev) => [...prev, {
      id: generateId(),
      role: "user",
      content: trimmed,
      timestamp: Date.now(),
      isStreaming: false,
    }]);

    // Send over WebSocket
    wsRef.current.send(JSON.stringify({ type: "user_message", text: trimmed }));
    setInputText("");
    setIsStreaming(true);
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

      {/* Messages */}
      <div style={styles.messageList}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            Send a message to start the conversation.
          </div>
        )}
        {messages.map((msg) => (
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
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {msg.content}
                {msg.isStreaming && <span style={styles.cursor}>|</span>}
              </div>
            </div>
          </div>
        ))}
        {toolStatus && (
          <div style={styles.messageBubbleWrapper}>
            <div style={styles.toolStatus}>{toolStatus}</div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} style={styles.inputBar}>
        <input
          ref={textInputRef}
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={isStreaming ? "Waiting for response..." : "Type a message..."}
          disabled={isStreaming}
          style={styles.textInput}
          autoFocus
        />
        <button
          type="submit"
          disabled={isStreaming || !inputText.trim()}
          style={{
            ...styles.sendButton,
            opacity: isStreaming || !inputText.trim() ? 0.5 : 1,
            cursor: isStreaming || !inputText.trim() ? "not-allowed" : "pointer",
          }}
        >
          Send
        </button>
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
  toolStatus: {
    fontSize: 12,
    color: "var(--text-secondary)",
    fontStyle: "italic",
    padding: "4px 0",
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
};
