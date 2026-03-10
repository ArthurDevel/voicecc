/**
 * Browser audio WebSocket handlers for the unified voice server.
 *
 * Provides WebSocket upgrade logic for browser-based audio sessions.
 * Used by voice-server.ts which owns the HTTP server.
 *
 * Responsibilities:
 * - Accept WebSocket upgrades on /audio?token=<deviceToken>
 * - Validate device tokens via isValidDeviceToken() (localhost bypasses validation)
 * - Reject duplicate connections for the same device token
 * - Create BrowserAudioAdapter + VoiceSession per connection
 */

import { WebSocketServer } from "ws";

import { createBrowserAudioAdapter } from "./browser-audio.js";
import { createVoiceSession } from "./voice-session.js";
import { isValidDeviceToken } from "../services/device-pairing.js";
import { readEnv } from "../services/env.js";

import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { WebSocket } from "ws";
import type { VoiceSession } from "./voice-session.js";
import type { TtsProviderConfig, SttProviderConfig } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Interruption threshold for browser calls (lower than Twilio's 2000ms because browser getUserMedia includes AEC) */
const BROWSER_INTERRUPTION_THRESHOLD_MS = 1500;

/** Default ElevenLabs voice ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_VOICE_ID = "WrjxnKxK0m1uiaH0uteU";

/** Default ElevenLabs TTS model ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

/** Default ElevenLabs STT model ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_STT_MODEL_ID = "scribe_v1";

// ============================================================================
// TYPES
// ============================================================================

/** Tracks an active browser audio session */
interface ActiveBrowserSession {
  /** The device token used for this session */
  deviceToken: string;
  /** Voice session handle (null until created) */
  session: VoiceSession | null;
}

// ============================================================================
// STATE
// ============================================================================

/** Active sessions keyed by device token */
const activeSessions = new Map<string, ActiveBrowserSession>();

// ============================================================================
// EXPORTED HANDLERS
// ============================================================================

/**
 * Handle a WebSocket upgrade request for browser audio.
 *
 * Validates that the path is /audio, extracts the device token from the query
 * string, checks authorization (localhost or valid device token), and rejects
 * duplicate connections for the same device token.
 *
 * @param req - HTTP upgrade request
 * @param socket - Underlying TCP socket
 * @param head - First packet of the upgraded stream
 * @param wss - WebSocketServer instance to accept the upgrade
 */
export function handleBrowserUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): void {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);

  // Validate path
  if (url.pathname !== "/audio") {
    console.log(`Rejected WebSocket upgrade: invalid path ${url.pathname}`);
    socket.destroy();
    return;
  }

  // Extract device token from query string
  const token = url.searchParams.get("token") ?? "";

  // Check authorization: localhost bypasses token validation
  const remoteAddr = req.socket.remoteAddress ?? "";
  const isLocalhost =
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";

  if (!isLocalhost && !token) {
    console.log("Rejected WebSocket upgrade: missing device token");
    socket.destroy();
    return;
  }

  if (!isLocalhost && !isValidDeviceToken(token)) {
    console.log("Rejected WebSocket upgrade: invalid device token");
    socket.destroy();
    return;
  }

  // Reject duplicate connections for the same device token
  if (token && activeSessions.has(token)) {
    console.log(`Rejected WebSocket upgrade: duplicate device token ${token}`);
    socket.destroy();
    return;
  }

  // Accept the WebSocket connection
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
    handleBrowserSession(ws, token || "localhost");
  });
}

// ============================================================================
// INTERNAL HANDLERS
// ============================================================================

/**
 * Handle a connected browser audio WebSocket session.
 *
 * Creates a BrowserAudioAdapter and VoiceSession with browser-tuned config.
 * Registers close/error handlers for cleanup. Removes from activeSessions
 * on disconnect.
 *
 * @param ws - Connected WebSocket for browser audio
 * @param deviceToken - Device token identifying this connection
 */
function handleBrowserSession(ws: WebSocket, deviceToken: string): void {
  let cleaned = false;

  // Register in active sessions
  const entry: ActiveBrowserSession = { deviceToken, session: null };
  activeSessions.set(deviceToken, entry);

  console.log(`Browser session connected, token: ${deviceToken}`);

  /**
   * Clean up the browser session. Stops the voice session and removes from
   * the activeSessions map. Uses cleaned flag to prevent double-cleanup.
   */
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    if (entry.session) {
      await entry.session.stop();
    }

    activeSessions.delete(deviceToken);
    console.log(`Browser session cleaned up, token: ${deviceToken}`);
  }

  // WebSocket close handler
  ws.on("close", () => {
    cleanup().catch((err) => {
      console.error(`Error during browser session cleanup: ${err}`);
    });
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for token ${deviceToken}: ${err}`);
  });

  // Create adapter and voice session
  createSession(ws, entry).catch((err) => {
    console.error(`Failed to create voice session for token ${deviceToken}: ${err}`);
    ws.close();
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build provider config by reading the latest values from .env.
 * Called per-session so changes to API keys, voice IDs, or model IDs
 * take effect without a server restart.
 *
 * @returns TTS and STT provider configs with current .env values
 */
async function buildProviderConfig(): Promise<{ ttsProvider: TtsProviderConfig; sttProvider: SttProviderConfig }> {
  const env = await readEnv();

  const apiKey = env.ELEVENLABS_API_KEY ?? "";
  const voiceId = env.ELEVENLABS_VOICE_ID ?? DEFAULT_ELEVENLABS_VOICE_ID;
  const modelId = env.ELEVENLABS_MODEL_ID ?? DEFAULT_ELEVENLABS_MODEL_ID;
  const sttModelId = env.ELEVENLABS_STT_MODEL_ID ?? DEFAULT_ELEVENLABS_STT_MODEL_ID;

  return {
    ttsProvider: { provider: "elevenlabs", elevenlabs: { apiKey, voiceId, modelId } },
    sttProvider: { provider: "elevenlabs", elevenlabs: { apiKey, modelId: sttModelId } },
  };
}

/**
 * Create the BrowserAudioAdapter and VoiceSession for a connected WebSocket.
 *
 * @param ws - Connected WebSocket for browser audio
 * @param entry - Active session entry to populate with the voice session
 */
async function createSession(ws: WebSocket, entry: ActiveBrowserSession): Promise<void> {
  const adapter = createBrowserAudioAdapter({ ws });

  const { ttsProvider, sttProvider } = await buildProviderConfig();

  const session = await createVoiceSession(adapter, {
    stopPhrase: "stop listening",
    ttsProvider,
    sttProvider,
    interruptionThresholdMs: BROWSER_INTERRUPTION_THRESHOLD_MS,
    endpointing: {
      silenceThresholdMs: 700,
      maxSilenceBeforeTimeoutMs: 1200,
      minWordCountForFastPath: 2,
      enableHaikuFallback: false,
    },
    narration: {
      summaryIntervalMs: 12000,
    },
    claudeSession: {
      allowedTools: [] as string[],
      permissionMode: "bypassPermissions",
      systemPrompt:
        "Respond concisely. You are in voice mode -- your responses will be spoken aloud. Keep answers conversational and brief.",
    },
    onSessionEnd: () => ws.close(),
  });

  entry.session = session;
}
