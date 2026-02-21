/**
 * Standalone HTTP + WebSocket server for browser audio sessions.
 *
 * Runs on TWILIO_PORT (default 8080) -- same port as twilio-server.ts.
 * Only one of browser-server / twilio-server runs at a time.
 * Entry point for the browser call sidecar process.
 *
 * Responsibilities:
 * - Start HTTP server on TWILIO_PORT for browser audio connections
 * - Accept WebSocket upgrades on /audio?token=<deviceToken>
 * - Validate device tokens via isValidDeviceToken() (localhost bypasses validation)
 * - Reject duplicate connections for the same device token
 * - Create BrowserAudioAdapter + VoiceSession per connection
 * - Proxy non-audio HTTP requests to the dashboard server
 * - Send periodic ws.ping() to keep connections alive through ngrok
 */

import "dotenv/config";

import { createServer, request as httpRequest } from "http";
import { homedir } from "os";
import { join } from "path";

import { WebSocketServer } from "ws";

import { createBrowserAudioAdapter } from "./browser-audio.js";
import { createVoiceSession } from "./voice-session.js";
import { isValidDeviceToken } from "../services/device-pairing.js";

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import type { WebSocket } from "ws";
import type { VoiceSession } from "./voice-session.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default port for the browser audio server (same as Twilio) */
const DEFAULT_PORT = 8080;

/** Interruption threshold for browser calls (lower than Twilio's 2000ms because browser getUserMedia includes AEC) */
const BROWSER_INTERRUPTION_THRESHOLD_MS = 1500;

/** Ping interval to keep WebSocket connections alive through ngrok (ms) */
const PING_INTERVAL_MS = 30_000;

/** Default voice session config for browser calls */
const DEFAULT_CONFIG = {
  stopPhrase: "stop listening",
  sttModelPath: join(homedir(), ".claude-voice-models", "whisper-small"),
  ttsModel: "prince-canuma/Kokoro-82M",
  ttsVoice: "af_heart",
  modelCacheDir: join(homedir(), ".claude-voice-models"),
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
};

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
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the browser audio HTTP + WebSocket server.
 *
 * Reads TWILIO_PORT (default 8080) and DASHBOARD_PORT from environment.
 * Creates an HTTP server that proxies non-audio requests to the dashboard.
 * WebSocket upgrade on /audio?token=<token> with device token validation.
 * Sends periodic ws.ping() every 30s to keep connections alive through ngrok.
 *
 * @returns Resolves when the server is listening
 * @throws Error if DASHBOARD_PORT is not set
 */
async function startBrowserServer(): Promise<void> {
  const port = parseInt(process.env.TWILIO_PORT ?? "", 10) || DEFAULT_PORT;
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "", 10);

  if (!dashboardPort) {
    throw new Error("DASHBOARD_PORT is required");
  }

  // Create HTTP server
  const server = createServer((req, res) => {
    // Proxy all HTTP requests to the dashboard server
    proxyToDashboard(req, res, dashboardPort);
  });

  // Create WebSocket server (no automatic HTTP handling -- upgrades only)
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade requests
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleWebSocketUpgrade(req, socket, head, wss);
  });

  // Periodic ping to keep connections alive through ngrok
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    });
  }, PING_INTERVAL_MS);

  // Start listening
  return new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`Browser audio server listening on port ${port}`);
      resolve();
    });
  });
}

// ============================================================================
// MAIN HANDLERS
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
function handleWebSocketUpgrade(
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
 * Create the BrowserAudioAdapter and VoiceSession for a connected WebSocket.
 *
 * @param ws - Connected WebSocket for browser audio
 * @param entry - Active session entry to populate with the voice session
 */
async function createSession(ws: WebSocket, entry: ActiveBrowserSession): Promise<void> {
  const adapter = createBrowserAudioAdapter({ ws });

  const session = await createVoiceSession(adapter, {
    ...DEFAULT_CONFIG,
    onSessionEnd: () => ws.close(),
  });

  entry.session = session;
}

/**
 * Proxy an HTTP request to the dashboard server on localhost.
 * Forwards the request method, path, headers, and body.
 *
 * @param req - Original incoming request
 * @param res - Response to write the proxied result to
 * @param dashboardPort - Port the dashboard server is listening on
 */
function proxyToDashboard(req: IncomingMessage, res: ServerResponse, dashboardPort: number): void {
  const proxyReq = httpRequest(
    {
      hostname: "127.0.0.1",
      port: dashboardPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Dashboard unavailable");
  });

  req.pipe(proxyReq);
}

// ============================================================================
// ENTRY POINT
// ============================================================================

startBrowserServer().catch((err) => {
  console.error(`Browser audio server failed: ${err}`);
  process.exit(1);
});
