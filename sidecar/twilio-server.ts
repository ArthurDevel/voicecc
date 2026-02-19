/**
 * HTTP + WebSocket server that accepts Twilio phone calls and creates a
 * voice session per call.
 *
 * Standalone entry point for the Twilio voice call path. Runs as a separate
 * process from the local mic path (index.ts).
 *
 * Responsibilities:
 * - Start HTTP server on TWILIO_PORT for Twilio webhooks
 * - Validate incoming call webhooks via Twilio signature verification
 * - Generate per-call UUID tokens for secure WebSocket upgrade
 * - Accept Twilio media stream WebSocket connections
 * - Create a TwilioAudioAdapter + VoiceSession per call
 * - Enforce global session limit via session locks
 * - Tear down sessions on hangup, stop phrase, or error
 */

import "dotenv/config";

import { randomUUID } from "crypto";
import { createServer, request as httpRequest } from "http";
import { homedir } from "os";
import { join } from "path";

import twilio from "twilio";
import { WebSocketServer } from "ws";

import { createTwilioAudioAdapter } from "./twilio-audio.js";
import { createVoiceSession } from "./voice-session.js";

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import type { WebSocket } from "ws";
import type { VoiceSession } from "./voice-session.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default port for the Twilio HTTP/WebSocket server */
const DEFAULT_PORT = 8080;

/** Interruption threshold for phone calls (higher than local mic due to no VPIO echo cancellation) */
const PHONE_INTERRUPTION_THRESHOLD_MS = 2000;

/** Default voice session config for phone calls (same as index.ts DEFAULT_CONFIG but with phone-tuned threshold) */
const DEFAULT_CONFIG = {
  stopPhrase: "stop listening",
  sttModelPath: join(homedir(), ".claude-voice-models", "whisper-small"),
  ttsModel: "prince-canuma/Kokoro-82M",
  ttsVoice: "af_heart",
  modelCacheDir: join(homedir(), ".claude-voice-models"),
  interruptionThresholdMs: PHONE_INTERRUPTION_THRESHOLD_MS,
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

/** Tracks an active phone call from Twilio webhook through WebSocket session */
interface ActiveCall {
  /** Twilio call SID (populated when the WebSocket start event arrives) */
  callSid: string;
  /** Voice session handle (null until WebSocket start event creates it) */
  session: VoiceSession | null;
}

// ============================================================================
// STATE
// ============================================================================

/** Active calls keyed by per-call UUID token */
const activeCalls = new Map<string, ActiveCall>();

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the Twilio HTTP + WebSocket server.
 *
 * Loads configuration from .env via dotenv. Throws immediately if required
 * env vars (TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_URL) are missing.
 * Creates an HTTP server for the /twilio/incoming-call webhook and a
 * WebSocket server for Twilio media stream connections.
 *
 * @returns Resolves when the server is listening
 * @throws Error if TWILIO_AUTH_TOKEN or TWILIO_WEBHOOK_URL are not set
 */
async function startTwilioServer(): Promise<void> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const webhookUrl = process.env.TWILIO_WEBHOOK_URL;
  const port = parseInt(process.env.TWILIO_PORT ?? "", 10) || DEFAULT_PORT;

  if (!authToken) {
    throw new Error("TWILIO_AUTH_TOKEN is required in .env");
  }
  if (!webhookUrl) {
    throw new Error("TWILIO_WEBHOOK_URL is required in .env");
  }

  // Extract the host from the webhook URL for TwiML WebSocket URLs
  const webhookHost = new URL(webhookUrl).host;

  const dashboardPort = parseInt(process.env.DASHBOARD_PORT ?? "", 10);

  // Create HTTP server
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/twilio/incoming-call") {
      handleIncomingCall(req, res, authToken, webhookUrl, webhookHost);
      return;
    }

    // Proxy all other requests to the dashboard server
    if (dashboardPort) {
      proxyToDashboard(req, res, dashboardPort);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  // Create WebSocket server (no automatic HTTP handling -- upgrades only)
  const wss = new WebSocketServer({ noServer: true });

  // Handle WebSocket upgrade requests
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleWebSocketUpgrade(req, socket, head, wss);
  });

  // Start listening
  return new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`Twilio server listening on port ${port}`);
      console.log(`Webhook URL: ${webhookUrl}`);
      resolve();
    });
  });
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handle an incoming call webhook from Twilio (POST /twilio/incoming-call).
 *
 * Validates the Twilio request signature, generates a per-call token, and
 * responds with TwiML that tells Twilio to connect a media stream WebSocket.
 *
 * @param req - HTTP request from Twilio
 * @param res - HTTP response to send TwiML back
 * @param authToken - Twilio auth token for signature validation
 * @param webhookUrl - Public webhook URL for signature validation
 * @param webhookHost - Host portion of the webhook URL for WebSocket URLs
 */
function handleIncomingCall(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
  webhookUrl: string,
  webhookHost: string,
): void {
  // Collect the POST body for signature validation
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on("end", () => {
    // Parse URL-encoded POST body into key-value params
    const params = parseUrlEncodedBody(body);

    // Validate Twilio signature (use full URL -- Twilio signs against the complete endpoint URL)
    const validationUrl = webhookUrl.replace(/\/$/, "") + req.url;
    const signature = req.headers["x-twilio-signature"] as string;
    if (!signature || !twilio.validateRequest(authToken, signature, validationUrl, params)) {
      console.log("Rejected incoming call: invalid Twilio signature");
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // Generate per-call token and register in active calls
    const token = randomUUID();
    activeCalls.set(token, { callSid: "", session: null });

    console.log(`Incoming call accepted, token: ${token}`);

    // Respond with TwiML to connect a media stream
    const twiml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<Response>",
      "  <Connect>",
      `    <Stream url="wss://${webhookHost}/media/${token}" />`,
      "  </Connect>",
      "</Response>",
    ].join("\n");

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml);
  });
}

/**
 * Handle a WebSocket upgrade request for the Twilio media stream.
 *
 * Extracts the per-call token from the URL path, validates it against
 * the activeCalls map, and either accepts or rejects the connection.
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
  // Extract token from URL path: /media/:token
  const url = req.url ?? "";
  const match = url.match(/^\/media\/([a-f0-9-]+)$/);

  if (!match) {
    console.log(`Rejected WebSocket upgrade: invalid path ${url}`);
    socket.destroy();
    return;
  }

  const token = match[1];

  if (!activeCalls.has(token)) {
    console.log(`Rejected WebSocket upgrade: unknown token ${token}`);
    socket.destroy();
    return;
  }

  // Accept the WebSocket connection
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit("connection", ws, req);
    handleCallSession(ws, token);
  });
}

/**
 * Handle a connected Twilio media stream WebSocket session.
 *
 * Listens for Twilio WebSocket events (start, media, stop) and manages
 * the voice session lifecycle. On the "start" event, creates a
 * TwilioAudioAdapter and VoiceSession. On "stop" or WebSocket close,
 * tears down the session and cleans up.
 *
 * @param ws - Connected WebSocket for the Twilio media stream
 * @param token - Per-call UUID token identifying this call
 */
function handleCallSession(ws: WebSocket, token: string): void {
  let cleaned = false;

  /**
   * Clean up the call session. Stops the voice session, removes from
   * activeCalls map. Uses cleaned flag to prevent double-cleanup.
   */
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    const call = activeCalls.get(token);
    if (call?.session) {
      await call.session.stop();
    }

    activeCalls.delete(token);
    console.log(`Call session cleaned up, token: ${token}`);
  }

  // WebSocket close handler -- always runs cleanup regardless of cause
  ws.on("close", () => {
    cleanup().catch((err) => {
      console.error(`Error during call cleanup: ${err}`);
    });
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for token ${token}: ${err}`);
  });

  // Listen for Twilio media stream events
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));

    if (msg.event === "start") {
      handleStreamStart(ws, token, msg).catch((err) => {
        console.error(`Error handling stream start: ${err}`);
      });
      return;
    }

    if (msg.event === "stop") {
      console.log(`Twilio stream stopped for token: ${token}`);
      ws.close();
      return;
    }

    // "connected" and "media" events are handled elsewhere:
    // - "connected": informational, no action needed
    // - "media": handled by TwilioAudioAdapter's onAudio listener
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Handle the Twilio "start" event on a media stream WebSocket.
 *
 * Extracts the streamSid and callSid, creates a TwilioAudioAdapter and
 * VoiceSession. If session creation fails (e.g. limit reached), logs the
 * error and closes the WebSocket.
 *
 * @param ws - Connected WebSocket for the Twilio media stream
 * @param token - Per-call UUID token
 * @param msg - Parsed Twilio "start" event message
 */
async function handleStreamStart(
  ws: WebSocket,
  token: string,
  msg: { start: { streamSid: string; callSid: string } },
): Promise<void> {
  const { streamSid, callSid } = msg.start;
  console.log(`Stream started -- callSid: ${callSid}, streamSid: ${streamSid}`);

  // Update the active call entry with the callSid
  const call = activeCalls.get(token);
  if (!call) return;
  call.callSid = callSid;

  try {
    // Create the Twilio audio adapter
    const adapter = createTwilioAudioAdapter({ ws, streamSid });

    // Create the voice session (acquires a session lock -- may throw if limit reached)
    const session = await createVoiceSession(adapter, {
      ...DEFAULT_CONFIG,
      onSessionEnd: () => ws.close(),
    });

    call.session = session;
  } catch (err) {
    console.error(`Failed to create voice session for call ${callSid}: ${err}`);

    // Send a TwiML-style rejection message over the WebSocket is not possible,
    // so just close the WebSocket. The caller will hear silence and Twilio will
    // eventually disconnect.
    ws.close();
  }
}

/**
 * Parse a URL-encoded POST body into a key-value record.
 *
 * @param body - URL-encoded string (e.g. "key1=value1&key2=value2")
 * @returns Record of decoded key-value pairs
 */
function parseUrlEncodedBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};

  if (!body) return params;

  for (const pair of body.split("&")) {
    const [key, value] = pair.split("=");
    if (key) {
      params[decodeURIComponent(key)] = decodeURIComponent(value ?? "");
    }
  }

  return params;
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

startTwilioServer().catch((err) => {
  console.error(`Twilio server failed: ${err}`);
  process.exit(1);
});
