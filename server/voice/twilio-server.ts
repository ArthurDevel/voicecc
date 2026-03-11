/**
 * Twilio voice call handlers for the unified voice server.
 *
 * Provides HTTP request handlers and WebSocket upgrade logic for Twilio
 * phone calls. Used by voice-server.ts which owns the HTTP server.
 *
 * Responsibilities:
 * - Handle incoming call webhooks via Twilio signature verification
 * - Generate per-call UUID tokens for secure WebSocket upgrade
 * - Accept Twilio media stream WebSocket connections
 * - Create a TwilioAudioAdapter + VoiceSession per call
 * - Enforce global session limit via session locks
 * - Tear down sessions on hangup, stop phrase, or error
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import twilio from "twilio";
import { WebSocketServer } from "ws";

import { createTwilioAudioAdapter } from "./twilio-audio.js";
import { createVoiceSession } from "./voice-session.js";
import { createAudioInactivityWatchdog } from "./audio-inactivity.js";
import { getAgent, AGENTS_DIR } from "../services/agent-store.js";
import { getTunnelUrl } from "../services/tunnel.js";
import { readEnv } from "../services/env.js";

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import type { WebSocket } from "ws";
import type { VoiceSession } from "./voice-session.js";
import type { TtsProviderConfig, SttProviderConfig } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SYSTEM_PROMPT = readFileSync(join(__dirname, "..", "..", "init", "defaults", "system.md"), "utf-8").trim();

/** Interruption threshold for phone calls (higher than local mic due to no VPIO echo cancellation) */
const PHONE_INTERRUPTION_THRESHOLD_MS = 2000;

/** Close the WebSocket if no Twilio audio frames arrive within this window (ms) */
const AUDIO_INACTIVITY_TIMEOUT_MS = 5000;

/** How often to check for audio inactivity (ms) */
const AUDIO_INACTIVITY_CHECK_INTERVAL_MS = 2000;

/** Default ElevenLabs voice ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_VOICE_ID = "WrjxnKxK0m1uiaH0uteU";

/** Default ElevenLabs TTS model ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_turbo_v2_5";

/** Default ElevenLabs STT model ID (used when not set in .env) */
const DEFAULT_ELEVENLABS_STT_MODEL_ID = "scribe_v1";

// ============================================================================
// TYPES
// ============================================================================

/** Tracks an active phone call from Twilio webhook through WebSocket session */
interface ActiveCall {
  /** Twilio call SID (populated when the WebSocket start event arrives) */
  callSid: string;
  /** Voice session handle (null until WebSocket start event creates it) */
  session: VoiceSession | null;
  /** Agent identifier for agent-initiated calls (undefined for default inbound calls) */
  agentId?: string;
  /** Initial prompt for the agent to speak first (e.g. "Call Me" or heartbeat reason) */
  initialPrompt?: string;
  /** Pre-existing Claude session from heartbeat (passed to voice session instead of creating new one) */
  claudeSession?: import("./claude-session.js").ClaudeSession;
}

// ============================================================================
// STATE
// ============================================================================

/** Active calls keyed by per-call UUID token */
const activeCalls = new Map<string, ActiveCall>();

// ============================================================================
// EXPORTED HANDLERS
// ============================================================================

/**
 * Attach a pre-existing Claude session to a registered call token.
 * Called by the heartbeat scheduler after registering a token, so the
 * voice session can continue the same Claude session instead of creating a new one.
 *
 * @param token - The call token previously registered via /register-call
 * @param session - The live Claude session from the heartbeat check
 */
export function setCallClaudeSession(token: string, session: import("./claude-session.js").ClaudeSession): void {
  const call = activeCalls.get(token);
  if (call) {
    call.claudeSession = session;
  }
}

/**
 * Handle Twilio-specific HTTP requests.
 *
 * Routes POST /twilio/incoming-call and POST /register-call.
 * Returns true if the request was handled, false otherwise (so the
 * caller can fall through to other handlers like the dashboard proxy).
 *
 * @param req - HTTP request
 * @param res - HTTP response
 * @returns true if handled
 */
export function handleTwilioHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "POST" && req.url === "/twilio/incoming-call") {
    handleIncomingCall(req, res);
    return true;
  }

  if (req.method === "POST" && req.url === "/register-call") {
    handleRegisterCall(req, res);
    return true;
  }

  return false;
}

/**
 * Handle a WebSocket upgrade for Twilio media streams.
 *
 * Delegates to the internal handleWebSocketUpgrade with the shared WSS.
 *
 * @param req - HTTP upgrade request
 * @param socket - Underlying TCP socket
 * @param head - First packet of the upgraded stream
 * @param wss - WebSocketServer instance to accept the upgrade
 */
export function handleTwilioUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): void {
  handleWebSocketUpgrade(req, socket, head, wss);
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handle an incoming call webhook from Twilio (POST /twilio/incoming-call).
 *
 * Validates the Twilio request signature, generates a per-call token, and
 * responds with TwiML that tells Twilio to connect a media stream WebSocket.
 * Reads auth token and tunnel URL lazily per-request so values are always current.
 *
 * @param req - HTTP request from Twilio
 * @param res - HTTP response to send TwiML back
 */
function handleIncomingCall(
  req: IncomingMessage,
  res: ServerResponse,
): void {
  // Collect the POST body for signature validation
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on("end", async () => {
    // Read auth token and tunnel URL lazily per-request
    const env = await readEnv();
    const authToken = env.TWILIO_AUTH_TOKEN;
    const tunnelUrl = getTunnelUrl();

    if (!authToken) {
      console.log("Rejected incoming call: TWILIO_AUTH_TOKEN not set");
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server misconfigured");
      return;
    }

    if (!tunnelUrl) {
      console.log("Rejected incoming call: no tunnel URL available");
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Server misconfigured");
      return;
    }

    const webhookHost = new URL(tunnelUrl).host;

    // Parse URL-encoded POST body into key-value params
    const params = parseUrlEncodedBody(body);

    // Validate Twilio signature (use full URL -- Twilio signs against the complete endpoint URL)
    const webhookUrl = tunnelUrl.replace(/\/$/, "");
    const validationUrl = webhookUrl + req.url;
    const signature = req.headers["x-twilio-signature"] as string;
    if (!signature || !twilio.validateRequest(authToken, signature, validationUrl, params)) {
      console.log("Rejected incoming call: invalid Twilio signature");
      console.log("  validationUrl:", validationUrl);
      console.log("  signature:", signature);
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
 * Handle a POST /register-call request to pre-register an outbound call token.
 *
 * Called by the heartbeat scheduler or API before placing an outbound Twilio call.
 * Registers the token in activeCalls so the subsequent WebSocket upgrade is accepted.
 *
 * @param req - HTTP request with JSON body { token, agentId }
 * @param res - HTTP response
 */
function handleRegisterCall(req: IncomingMessage, res: ServerResponse): void {
  let body = "";
  req.on("data", (chunk: Buffer) => {
    body += chunk.toString();
  });

  req.on("end", () => {
    const { token, agentId, initialPrompt } = JSON.parse(body) as { token: string; agentId: string; initialPrompt?: string };
    activeCalls.set(token, { callSid: "", session: null, agentId, initialPrompt });

    console.log(`Registered outbound call token: ${token}, agentId: ${agentId}`);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
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
  // Extract token from URL path: /media/:token (allow optional query params)
  const url = req.url ?? "";
  const match = url.match(/^\/media\/([a-f0-9-]+)(?:\?.*)?$/);

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

  // Parse agentId from query string if present (used for outbound agent calls)
  const urlObj = new URL(url, "http://localhost");
  const queryAgentId = urlObj.searchParams.get("agentId");
  if (queryAgentId) {
    activeCalls.get(token)!.agentId = queryAgentId;
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

  // Detect stale calls: if Twilio stops sending audio frames (caller hung up
  // but WebSocket didn't close cleanly), close the WebSocket to trigger cleanup.
  const watchdog = createAudioInactivityWatchdog({
    timeoutMs: AUDIO_INACTIVITY_TIMEOUT_MS,
    checkIntervalMs: AUDIO_INACTIVITY_CHECK_INTERVAL_MS,
    onTimeout: () => {
      console.log(`[twilio-server] No audio received, closing stale call (token: ${token})`);
      ws.close();
    },
  });

  /**
   * Clean up the call session. Stops the voice session, removes from
   * activeCalls map. Uses cleaned flag to prevent double-cleanup.
   */
  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;

    watchdog.dispose();

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
    ws.close();
  });

  // Listen for Twilio media stream events
  ws.on("message", (data: Buffer | string) => {
    const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));

    if (msg.event === "media") {
      watchdog.ping();
      // Don't return -- TwilioAudioAdapter's onAudio listener also handles media events
    }

    if (msg.event === "start") {
      watchdog.ping();
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

  // Read provider config fresh from .env so key/model/voice changes take effect without restart
  const { ttsProvider, sttProvider } = await buildProviderConfig();

  const defaultConfig = {
    stopPhrase: "stop listening",
    ttsProvider,
    sttProvider,
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
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    } as import("./types.js").ClaudeSessionConfig,
  };

  // Build session config -- use agent personality if agentId is set, otherwise default
  const agentId = call.agentId;
  let sessionConfig: Parameters<typeof createVoiceSession>[1] = { ...defaultConfig, onSessionEnd: () => ws.close() };

  if (agentId) {
    try {
      const agent = await getAgent(agentId);
      const agentFiles = [
        `<SOUL.md>\n${agent.soulMd}\n</SOUL.md>`,
        `<HEARTBEAT.md>\n${agent.heartbeatMd}\n</HEARTBEAT.md>`,
        `<MEMORY.md>\n${agent.memoryMd}\n</MEMORY.md>`,
      ].join("\n\n");
      const agentDir = join(AGENTS_DIR, agentId);
      const agentPrompt = DEFAULT_SYSTEM_PROMPT
        .replaceAll("<<AGENT_DIR>>", agentDir)
        .replace("<<AGENT_FILES>>", agentFiles);
      sessionConfig = {
        ...defaultConfig,
        claudeSession: {
          ...defaultConfig.claudeSession,
          customSystemPrompt: agentPrompt,
          cwd: agentDir,
        },
        onSessionEnd: () => ws.close(),
      };
      // Override TTS voice if the agent has a preference
      if (agent.config.voice?.elevenlabs) {
        const voicePref = agent.config.voice.elevenlabs;
        const overriddenTts: TtsProviderConfig = {
          ...ttsProvider,
          elevenlabs: { ...ttsProvider.elevenlabs, voiceId: voicePref.id },
        };
        sessionConfig = { ...sessionConfig, ttsProvider: overriddenTts };
        console.log(`Using voice "${voicePref.name}" (${voicePref.id}) for agent "${agentId}"`);
      }

      // If heartbeat attached a live Claude session, pass it through
      if (call.claudeSession) {
        sessionConfig.existingClaudeSession = call.claudeSession;
        sessionConfig.initialPrompt = "The user just answered your call. Greet them and briefly explain why you're calling.";
        console.log(`Using existing heartbeat Claude session for agent "${agentId}" call ${callSid}`);
      } else if (call.initialPrompt) {
        sessionConfig.initialPrompt = call.initialPrompt;
        console.log(`Using agent "${agentId}" with initial prompt for call ${callSid}`);
      } else {
        console.log(`Using agent "${agentId}" personality for call ${callSid}`);
      }
    } catch (err) {
      console.error(`Failed to load agent "${agentId}", using default config:`, err);
    }
  }

  try {
    // Create the Twilio audio adapter
    const adapter = createTwilioAudioAdapter({ ws, streamSid });

    // Create the voice session (acquires a session lock -- may throw if limit reached)
    const session = await createVoiceSession(adapter, sessionConfig);

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
