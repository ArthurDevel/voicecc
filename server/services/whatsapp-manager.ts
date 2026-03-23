/**
 * Baileys WhatsApp socket lifecycle manager.
 *
 * Manages the connection to WhatsApp via the Baileys library, including
 * QR code generation for first-time linking, credential storage, reconnection
 * with exponential backoff, and permanent credential revocation handling.
 *
 * Responsibilities:
 * - Initialize and manage the Baileys socket connection
 * - Generate QR codes for first-time WhatsApp linking
 * - Store credentials at ~/.voicecc/whatsapp/ via useMultiFileAuthState
 * - Reconnect with exponential backoff on temporary disconnects
 * - Delete credentials and reset on permanent revocation (401/515)
 * - Trigger group sync on successful connection
 * - Forward incoming messages to the message handler
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  Browsers,
  type WASocket,
  type ConnectionState,
  proto,
} from "baileys";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { syncAllGroups } from "./whatsapp-groups.js"; // Created in Phase 3
import { shouldHandleMessage, handleIncomingMessage } from "./whatsapp-message-handler.js"; // Created in Phase 4

// ============================================================================
// CONSTANTS
// ============================================================================

/** Directory where Baileys stores auth credentials */
const CREDENTIALS_DIR = join(process.env.VOICECC_DIR ?? join(homedir(), ".voicecc"), "whatsapp");

/**
 * WhatsApp Web protocol version to use.
 * Baileys hardcodes an outdated version that WA servers reject with 405.
 * This must be updated when WhatsApp changes their accepted version range.
 * See: https://github.com/WhiskeySockets/Baileys/issues/2376
 */
const WA_VERSION: [number, number, number] = [2, 3000, 1034074495];

/** Initial reconnect delay in milliseconds */
const RECONNECT_BASE_DELAY_MS = 2_000;

/** Maximum reconnect delay in milliseconds (2 minutes) */
const RECONNECT_MAX_DELAY_MS = 120_000;

/** Disconnect status codes that indicate permanent credential revocation (delete creds) */
const PERMANENT_DISCONNECT_CODES = [
  DisconnectReason.loggedOut, // 401 -- user logged out from phone
];

/** Disconnect status codes that require a reconnect (keep creds) */
const RECONNECT_DISCONNECT_CODES = [
  DisconnectReason.restartRequired, // 515 -- expected after pairing, also periodic server restart
];

// ============================================================================
// TYPES
// ============================================================================

/** Connection state exposed to the dashboard and other modules */
export interface WhatsAppConnectionState {
  status: "disconnected" | "qr_pending" | "connecting" | "connected";
  qrCode: string | null;
}

// ============================================================================
// STATE
// ============================================================================

/** Current connection state */
let connectionState: WhatsAppConnectionState = {
  status: "disconnected",
  qrCode: null,
};

/** Active Baileys socket instance */
let socket: WASocket | null = null;

/** Current reconnect attempt count (resets on successful connection) */
let reconnectAttempt = 0;

/** Timer reference for pending reconnect */
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Whether stopWhatsApp was called intentionally (prevents auto-reconnect) */
let manuallyStopped = false;

/** Whether we have ever successfully connected in this session (connection === "open") */
let hasBeenConnected = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Initialize the Baileys socket and connect to WhatsApp.
 * On first connect (no stored credentials), enters QR pending state.
 * On successful connection, triggers group sync.
 *
 * @returns Resolves when the socket is initialized (not necessarily connected)
 */
export async function startWhatsApp(): Promise<void> {
  if (socket) {
    throw new Error("WhatsApp is already running");
  }

  manuallyStopped = false;
  reconnectAttempt = 0;
  hasBeenConnected = false;

  await createSocket();
}

/**
 * Close the Baileys socket and set state to disconnected.
 * Prevents automatic reconnection.
 */
export function stopWhatsApp(): void {
  manuallyStopped = true;
  clearReconnectTimer();
  destroySocket();
  connectionState = { status: "disconnected", qrCode: null };
  console.log("WhatsApp connection stopped.");
}

/**
 * Get the current WhatsApp connection state.
 *
 * @returns Current status and QR code (if pending)
 */
export function getConnectionState(): WhatsAppConnectionState {
  return { ...connectionState };
}

/**
 * Get the active Baileys socket for sending messages.
 *
 * @returns The active socket, or null if not connected
 */
export function getSocket(): WASocket | null {
  if (connectionState.status !== "connected") {
    return null;
  }
  return socket;
}

/**
 * Check if WhatsApp is currently connected.
 *
 * @returns True if connected
 */
export function isConnected(): boolean {
  return connectionState.status === "connected";
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create and configure a new Baileys socket with auth state and event handlers.
 * Sets up connection.update and messages.upsert event listeners.
 */
async function createSocket(): Promise<void> {
  // Ensure credentials directory exists
  mkdirSync(CREDENTIALS_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(CREDENTIALS_DIR);

  connectionState = { status: "connecting", qrCode: null };

  const sock = makeWASocket({
    version: WA_VERSION,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys),
    },
    browser: Browsers.macOS("VoiceCC"),
    printQRInTerminal: false,
  });

  socket = sock;

  // Save credentials whenever they are updated
  sock.ev.on("creds.update", saveCreds);

  // Handle connection state changes
  sock.ev.on("connection.update", (update: Partial<ConnectionState>) => {
    handleConnectionUpdate(update, sock);
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", (upsert) => {
    handleMessagesUpsert(upsert, sock);
  });
}

/**
 * Handle Baileys connection.update events.
 * Manages QR code display, successful connections, and disconnects.
 *
 * @param update - Partial connection state from Baileys
 */
function handleConnectionUpdate(update: Partial<ConnectionState>, sock: WASocket): void {
  const { connection, qr, lastDisconnect } = update;

  // QR code received -- user needs to scan
  if (qr) {
    connectionState = { status: "qr_pending", qrCode: qr };
    console.log("WhatsApp QR code generated. Scan it from the dashboard.");
    return;
  }

  if (connection === "open") {
    // Restore the socket reference (may have been nulled during a temporary close)
    socket = sock;
    connectionState = { status: "connected", qrCode: null };
    reconnectAttempt = 0;
    hasBeenConnected = true;
    console.log("WhatsApp connected successfully.");

    // Trigger group sync for all agents
    syncAllGroups().catch((err: unknown) => {
      console.error(`WhatsApp group sync failed: ${err}`);
    });
    return;
  }

  if (connection === "close") {
    const statusCode = extractDisconnectStatusCode(lastDisconnect?.error);
    console.log(`WhatsApp disconnected with status code: ${statusCode ?? "unknown"}`);

    // Clean up socket reference
    socket = null;

    // Permanent revocation (401): delete credentials and stop
    if (statusCode !== null && PERMANENT_DISCONNECT_CODES.includes(statusCode)) {
      console.log("WhatsApp credentials revoked. Deleting stored credentials.");
      deleteCredentials();
      connectionState = { status: "disconnected", qrCode: null };
      return;
    }

    // Restart required (515): reconnect immediately with existing credentials.
    // This is expected after initial pairing and during periodic server restarts.
    if (statusCode !== null && RECONNECT_DISCONNECT_CODES.includes(statusCode)) {
      console.log("WhatsApp restart required. Reconnecting with existing credentials...");
      connectionState = { status: "connecting", qrCode: null };
      scheduleReconnect();
      return;
    }

    // Other disconnects: only auto-reconnect if we previously had a successful connection.
    // During the initial pairing flow (QR scan), Baileys handles its own
    // internal retries. Creating a new socket here would kill the pairing.
    if (hasBeenConnected && !manuallyStopped) {
      connectionState = { status: "connecting", qrCode: null };
      scheduleReconnect();
    } else {
      connectionState = { status: "disconnected", qrCode: null };
    }
  }
}

/**
 * Handle incoming messages from Baileys.
 * Filters messages via shouldHandleMessage and routes valid ones to handleIncomingMessage.
 *
 * @param upsert - The messages.upsert event payload from Baileys
 * @param sock - The active Baileys socket
 */
function handleMessagesUpsert(
  upsert: { messages: proto.IWebMessageInfo[]; type: string },
  sock: WASocket
): void {
  // Only process new messages (not history sync)
  if (upsert.type !== "notify") {
    return;
  }

  const ownJid = sock.user?.id;
  if (!ownJid) {
    return;
  }

  for (const rawMsg of upsert.messages) {
    const parsed = shouldHandleMessage(rawMsg, ownJid);
    if (!parsed) {
      continue;
    }

    handleIncomingMessage(parsed).catch((err: unknown) => {
      console.error(`WhatsApp message handling failed for ${parsed.groupJid}: ${err}`);
    });
  }
}

/**
 * Extract the HTTP status code from a Baileys disconnect error.
 * Baileys disconnect errors carry an output.statusCode property.
 *
 * @param error - The disconnect error
 * @returns The status code, or null if not extractable
 */
function extractDisconnectStatusCode(error: Error | undefined): number | null {
  if (!error) {
    return null;
  }

  // Baileys disconnect errors have an output.statusCode property
  const maybeStatusCode = (error as unknown as { output?: { statusCode?: number } }).output?.statusCode;
  if (typeof maybeStatusCode === "number") {
    return maybeStatusCode;
  }

  return null;
}

/**
 * Schedule a reconnect attempt with exponential backoff.
 * Doubles the delay on each attempt, capped at RECONNECT_MAX_DELAY_MS.
 */
function scheduleReconnect(): void {
  clearReconnectTimer();

  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttempt),
    RECONNECT_MAX_DELAY_MS
  );
  reconnectAttempt++;

  console.log(`WhatsApp reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})...`);

  reconnectTimer = setTimeout(async () => {
    if (manuallyStopped) {
      return;
    }

    try {
      await createSocket();
    } catch (err: unknown) {
      console.error(`WhatsApp reconnect failed: ${err}`);
      if (!manuallyStopped) {
        scheduleReconnect();
      }
    }
  }, delay);
}

/**
 * Clear any pending reconnect timer.
 */
function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Close and clean up the active socket.
 */
function destroySocket(): void {
  if (socket) {
    try {
      socket.end(undefined);
    } catch {
      // Socket may already be closed
    }
    socket = null;
  }
}

/**
 * Delete stored WhatsApp credentials from disk.
 * Used when credentials are permanently revoked (401/515).
 */
function deleteCredentials(): void {
  if (existsSync(CREDENTIALS_DIR)) {
    try {
      rmSync(CREDENTIALS_DIR, { recursive: true, force: true });
      console.log(`Deleted WhatsApp credentials at ${CREDENTIALS_DIR}`);
    } catch (err: unknown) {
      console.error(`Failed to delete WhatsApp credentials: ${err}`);
    }
  }
}
