/**
 * Dashboard HTTP server -- CLAUDE.md editor and conversation viewer.
 *
 * Serves the dashboard UI and exposes REST APIs.
 *
 * Responsibilities:
 * - Serve the editor UI from dashboard/public/
 * - Expose REST API to read and write CLAUDE.md
 * - Expose REST API to list and read conversation sessions from Claude Code JSONL logs
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, writeFile, access, readdir, stat } from "fs/promises";
import { join, extname, basename } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { createReadStream } from "fs";
import { createInterface } from "readline";
import { execFile, spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import twilioSdk from "twilio";

// ============================================================================
// CONSTANTS
// ============================================================================

const PORTS_TO_TRY = [3456, 3457, 3458, 3459, 3460];

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const CLAUDE_MD_PATH = join(process.cwd(), "CLAUDE.md");
const ENV_PATH = join(process.cwd(), ".env");
const USER_CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");

/** Directory where Claude Code stores session JSONL files for this project.
 *  Claude Code encodes the project path by replacing "/" with "-". */
const PROJECT_DIR_NAME = process.cwd().replace(/\//g, "-");
const SESSIONS_DIR = join(homedir(), ".claude", "projects", PROJECT_DIR_NAME);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
};

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the dashboard HTTP server. Tries each port in PORTS_TO_TRY
 * until one is available.
 *
 * @returns Resolves when the server is listening
 */
export async function startDashboard(): Promise<void> {
  await loadDeviceTokens();
  for (const port of PORTS_TO_TRY) {
    try {
      await listenOnPort(port);
      return;
    } catch (err: any) {
      if (err.code === "EADDRINUSE") {
        console.log(`Port ${port} in use, trying next...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`All ports in use: ${PORTS_TO_TRY.join(", ")}`);
}

/**
 * Attempt to start the HTTP server on a specific port.
 *
 * @param port - Port to listen on
 * @returns Resolves when the server is listening
 */
function listenOnPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest);
    server.on("error", reject);
    server.listen(port, () => {
      dashboardPort = port;
      console.log(`Dashboard running at http://localhost:${port}`);
      resolve();
    });
  });
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Route incoming HTTP requests to the appropriate handler.
 *
 * @param req - Incoming HTTP request
 * @param res - Server response
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      await handleStatus(res);
    } else if (pathname === "/api/claude-md" && req.method === "GET") {
      await handleRead(res);
    } else if (pathname === "/api/claude-md" && req.method === "POST") {
      await handleWrite(req, res);
    } else if (pathname === "/api/voice/start" && req.method === "POST") {
      handleStartVoice(res);
    } else if (pathname === "/api/conversations" && req.method === "GET") {
      await handleListConversations(res);
    } else if (pathname.startsWith("/api/conversations/") && req.method === "GET") {
      const sessionId = pathname.slice("/api/conversations/".length);
      await handleGetConversation(sessionId, res);
    } else if (pathname === "/api/settings" && req.method === "GET") {
      await handleGetSettings(res);
    } else if (pathname === "/api/settings" && req.method === "POST") {
      await handleUpdateSettings(req, res);
    } else if (pathname === "/api/twilio/status" && req.method === "GET") {
      sendJson(res, 200, getStatus());
    } else if (pathname === "/api/twilio/start" && req.method === "POST") {
      await handleStart(res);
    } else if (pathname === "/api/twilio/stop" && req.method === "POST") {
      await handleStop(res);
    } else if (pathname === "/api/twilio/check-ngrok" && req.method === "GET") {
      await handleCheckNgrok(res);
    } else if (pathname === "/api/twilio/ngrok-authtoken" && req.method === "POST") {
      await handleNgrokAuthtoken(req, res);
    } else if (pathname === "/api/twilio/phone-numbers" && req.method === "GET") {
      await handleGetPhoneNumbers(res);
    } else if (pathname === "/api/twilio/setup-webrtc" && req.method === "POST") {
      await handleSetupWebrtc(res);
    } else if (pathname === "/api/twilio/token" && req.method === "GET") {
      await handleGetTwilioToken(req, res);
    } else if (pathname === "/api/webrtc/generate-code" && req.method === "POST") {
      handleGeneratePairingCode(req, res);
    } else if (pathname === "/api/webrtc/pair" && req.method === "POST") {
      await handlePairDevice(req, res);
    } else if (pathname === "/api/webrtc/validate" && req.method === "GET") {
      handleValidateDevice(req, res);
    } else {
      await handleStaticFile(pathname, res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Check for potential conflicts (e.g. user-level CLAUDE.md).
 * GET /api/status
 *
 * @param res - Server response
 */
async function handleStatus(res: ServerResponse): Promise<void> {
  const hasUserClaudeMd = await fileExists(USER_CLAUDE_MD_PATH);
  sendJson(res, 200, {
    userClaudeMdExists: hasUserClaudeMd,
    userClaudeMdPath: USER_CLAUDE_MD_PATH,
  });
}

/**
 * Read the CLAUDE.md file.
 * GET /api/claude-md
 *
 * @param res - Server response
 */
async function handleRead(res: ServerResponse): Promise<void> {
  const content = await readFile(CLAUDE_MD_PATH, "utf-8");
  sendJson(res, 200, { content });
}

/**
 * Write the CLAUDE.md file.
 * POST /api/claude-md
 * Body: { "content": "file contents" }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response
 */
async function handleWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { content } = JSON.parse(body);

  if (content === undefined) {
    sendJson(res, 400, { error: "Missing 'content' in request body" });
    return;
  }

  await writeFile(CLAUDE_MD_PATH, content, "utf-8");
  sendJson(res, 200, { success: true });
}

// ============================================================================
// VOICE HANDLER
// ============================================================================

/** The command to run in Terminal.app to start the voice sidecar */
const VOICE_CMD = `cd ${process.cwd()} && npx tsx sidecar/index.ts`;

/**
 * Open Terminal.app and start the voice sidecar process.
 * POST /api/voice/start
 *
 * @param res - Server response
 */
function handleStartVoice(res: ServerResponse): void {
  const script = `tell application "Terminal"
  activate
  do script "${VOICE_CMD}"
end tell`;

  execFile("osascript", ["-e", script], (err) => {
    if (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    sendJson(res, 200, { success: true });
  });
}

// ============================================================================
// SETTINGS HANDLERS
// ============================================================================

/**
 * Read the .env file and return its key-value pairs as JSON.
 * Masks the TWILIO_AUTH_TOKEN value, showing only the last 4 characters.
 * GET /api/settings
 *
 * @param res - Server response
 */
async function handleGetSettings(res: ServerResponse): Promise<void> {
  if (!(await fileExists(ENV_PATH))) {
    sendJson(res, 200, {});
    return;
  }

  const content = await readFile(ENV_PATH, "utf-8");
  const settings = parseEnvFile(content);

  // Mask auth tokens -- show only last 4 chars
  for (const key of ["TWILIO_AUTH_TOKEN", "NGROK_AUTHTOKEN", "TWILIO_API_KEY_SECRET"]) {
    if (settings[key]) {
      const val = settings[key];
      settings[key] = val.length > 4 ? "****" + val.slice(-4) : "****" + val;
    }
  }

  sendJson(res, 200, settings);
}

/**
 * Write key-value pairs to the .env file.
 * If TWILIO_AUTH_TOKEN starts with "****", preserves the existing value.
 * POST /api/settings
 *
 * @param req - Incoming HTTP request with JSON body of key-value pairs
 * @param res - Server response
 */
async function handleUpdateSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const incoming: Record<string, string> = JSON.parse(body);

  // Read existing settings and merge (don't wipe keys not present in the payload)
  const existingContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const settings = parseEnvFile(existingContent);

  for (const [key, value] of Object.entries(incoming)) {
    // If auth tokens are masked, preserve the existing value
    if ((key === "TWILIO_AUTH_TOKEN" || key === "NGROK_AUTHTOKEN" || key === "TWILIO_API_KEY_SECRET") && value.startsWith("****")) {
      continue;
    }
    settings[key] = value;
  }

  const lines = Object.entries(settings).map(([k, v]) => `${k}=${v}`);
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf-8");
  sendJson(res, 200, { success: true });
}

/**
 * Parse a .env file string into a key-value record.
 * Handles lines in the format KEY=VALUE, ignores empty lines and comments.
 *
 * @param content - Raw .env file content
 * @returns Parsed key-value pairs
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

// ============================================================================
// TWILIO HANDLERS
// ============================================================================

/**
 * Start ngrok + Twilio server.
 * POST /api/twilio/start
 *
 * @param res - Server response
 */
async function handleStart(res: ServerResponse): Promise<void> {
  try {
    const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
    const envVars = parseEnvFile(envContent);
    const port = parseInt(envVars.TWILIO_PORT || "8080", 10);

    if (!ngrokUrl) {
      await startNgrok(port);
    }
    if (!twilioRunning) {
      await startTwilioServer();
    }
    sendJson(res, 200, { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Stop the Twilio server and ngrok.
 * POST /api/twilio/stop
 *
 * @param res - Server response
 */
async function handleStop(res: ServerResponse): Promise<void> {
  stopTwilioServer();
  stopNgrok();
  sendJson(res, 200, { success: true });
}

/**
 * Check if ngrok is installed by attempting to run `ngrok version`.
 * GET /api/twilio/check-ngrok
 *
 * @param res - Server response
 */
async function handleCheckNgrok(res: ServerResponse): Promise<void> {
  const installed = await new Promise<boolean>((resolve) => {
    try {
      const child = execFile("ngrok", ["version"], (err) => resolve(!err));
      child.on("error", () => {}); // Suppress duplicate error event
    } catch {
      resolve(false);
    }
  });
  sendJson(res, 200, { installed });
}

/**
 * Configure ngrok authtoken by running `ngrok config add-authtoken <token>`.
 * POST /api/twilio/ngrok-authtoken
 * Body: { "token": "..." }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response
 */
async function handleNgrokAuthtoken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { token } = JSON.parse(body);
  if (!token || typeof token !== "string") {
    sendJson(res, 400, { error: "Missing 'token' in request body" });
    return;
  }

  const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
    try {
      const child = execFile("ngrok", ["config", "add-authtoken", token.trim()], (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stdout || stderr || "").trim() });
      });
      child.on("error", () => resolve({ ok: false, output: "ngrok is not installed" }));
    } catch {
      resolve({ ok: false, output: "Failed to run ngrok" });
    }
  });

  if (result.ok) {
    sendJson(res, 200, { success: true, output: result.output });
  } else {
    sendJson(res, 500, { error: result.output });
  }
}

/**
 * Fetch phone numbers from the Twilio API using Account SID and Auth Token.
 * GET /api/twilio/phone-numbers
 *
 * @param res - Server response
 */
async function handleGetPhoneNumbers(res: ServerResponse): Promise<void> {
  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const authToken = envVars.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    sendJson(res, 400, { error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set" });
    return;
  }

  const apiUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  const apiRes = await fetch(apiUrl, {
    headers: { Authorization: `Basic ${auth}` },
  });

  if (!apiRes.ok) {
    const body = await apiRes.text();
    sendJson(res, apiRes.status, { error: `Twilio API error: ${body}` });
    return;
  }

  const data = await apiRes.json();
  const numbers = (data.incoming_phone_numbers ?? []).map(
    (n: { phone_number: string; friendly_name: string }) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
    })
  );

  sendJson(res, 200, { numbers });
}

/**
 * Auto-create Twilio API Key and TwiML Application for WebRTC browser calling.
 * POST /api/twilio/setup-webrtc
 *
 * @param res - Server response
 */
async function handleSetupWebrtc(res: ServerResponse): Promise<void> {
  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const authToken = envVars.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    sendJson(res, 400, { error: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set first" });
    return;
  }

  const client = twilioSdk(accountSid, authToken);

  // Determine voice URL for the TwiML App
  const voiceUrl = ngrokUrl
    ? `${ngrokUrl}/twilio/incoming-call`
    : "";

  // Create API Key if not already set
  let apiKeySid = envVars.TWILIO_API_KEY_SID;
  let apiKeySecret = envVars.TWILIO_API_KEY_SECRET;

  if (!apiKeySid || !apiKeySecret) {
    const key = await client.iam.v1.newApiKey.create({
      accountSid,
      friendlyName: "claude-voice-webrtc",
    });
    apiKeySid = key.sid;
    apiKeySecret = key.secret!;
    await writeEnvKey("TWILIO_API_KEY_SID", apiKeySid);
    await writeEnvKey("TWILIO_API_KEY_SECRET", apiKeySecret);
  }

  // Create TwiML Application if not already set
  let twimlAppSid = envVars.TWILIO_TWIML_APP_SID;

  if (!twimlAppSid) {
    const app = await client.applications.create({
      friendlyName: "Claude Voice WebRTC",
      voiceUrl: voiceUrl,
      voiceMethod: "POST",
    });
    twimlAppSid = app.sid;
    await writeEnvKey("TWILIO_TWIML_APP_SID", twimlAppSid);
  } else if (voiceUrl) {
    // Update existing TwiML App with current voice URL
    await client.applications(twimlAppSid).update({
      voiceUrl: voiceUrl,
      voiceMethod: "POST",
    });
  }

  webrtcConfigured = true;

  sendJson(res, 200, {
    success: true,
    apiKeySid,
    twimlAppSid,
  });
}

/**
 * Generate a short-lived Twilio Access Token for the browser Voice SDK.
 * Requires either localhost access or a valid device token (Bearer header).
 * GET /api/twilio/token
 *
 * @param req - Incoming HTTP request (for auth check)
 * @param res - Server response
 */
async function handleGetTwilioToken(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLocalhostRequest(req) && !deviceTokens.has(getDeviceToken(req))) {
    sendJson(res, 403, { error: "Unauthorized" });
    return;
  }

  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const apiKeySid = envVars.TWILIO_API_KEY_SID;
  const apiKeySecret = envVars.TWILIO_API_KEY_SECRET;
  const twimlAppSid = envVars.TWILIO_TWIML_APP_SID;

  if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) {
    sendJson(res, 400, {
      error: "WebRTC not set up. Run setup first.",
      needsSetup: true,
    });
    return;
  }

  const AccessToken = twilioSdk.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(accountSid, apiKeySid, apiKeySecret, {
    identity: "claude-voice-browser",
    ttl: 3600,
  });

  token.addGrant(new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: false,
  }));

  sendJson(res, 200, { token: token.toJwt() });
}

// ============================================================================
// DEVICE PAIRING HANDLERS
// ============================================================================

/**
 * Generate a 6-digit pairing code for device authentication.
 * Localhost-only -- only the dashboard user can generate codes.
 * POST /api/webrtc/generate-code
 *
 * @param req - Incoming HTTP request (checked for localhost)
 * @param res - Server response with { code, expiresAt }
 */
function handleGeneratePairingCode(req: IncomingMessage, res: ServerResponse): void {
  if (!isLocalhostRequest(req)) {
    sendJson(res, 403, { error: "Pairing codes can only be generated from localhost" });
    return;
  }

  // Generate a 6-digit numeric code
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;

  pairingCodes.set(code, { expiresAt, attempts: 0 });

  sendJson(res, 200, { code, expiresAt });
}

/**
 * Validate a pairing code and issue a device token.
 * POST /api/webrtc/pair
 * Body: { "code": "123456" }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response with { token } on success
 */
async function handlePairDevice(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { code } = JSON.parse(body);

  if (!code || typeof code !== "string") {
    sendJson(res, 400, { error: "Missing 'code' in request body" });
    return;
  }

  const entry = pairingCodes.get(code);

  if (!entry) {
    sendJson(res, 401, { error: "Invalid pairing code" });
    return;
  }

  if (Date.now() > entry.expiresAt) {
    pairingCodes.delete(code);
    sendJson(res, 401, { error: "Pairing code expired" });
    return;
  }

  entry.attempts++;
  if (entry.attempts > PAIRING_MAX_ATTEMPTS) {
    pairingCodes.delete(code);
    sendJson(res, 401, { error: "Too many attempts, code invalidated" });
    return;
  }

  // Code is valid -- delete it (single-use) and issue a device token
  pairingCodes.delete(code);
  const token = randomUUID();
  const userAgent = req.headers["user-agent"] ?? "unknown";
  deviceTokens.set(token, { pairedAt: Date.now(), userAgent });
  saveDeviceTokens().catch(() => {});

  sendJson(res, 200, { token });
}

/**
 * Validate a device token from the Authorization header.
 * GET /api/webrtc/validate
 *
 * @param req - Incoming HTTP request with Bearer token
 * @param res - Server response with { valid: boolean }
 */
function handleValidateDevice(req: IncomingMessage, res: ServerResponse): void {
  const token = getDeviceToken(req);
  const valid = deviceTokens.has(token);
  sendJson(res, 200, { valid });
}

// ============================================================================
// PROCESS STATE
// ============================================================================

/** Dashboard port (set when server starts, passed to twilio-server for proxying) */
let dashboardPort = 0;

/** Whether WebRTC is configured (API Key + TwiML App exist in .env) */
let webrtcConfigured = false;

/** Active pairing codes: code -> { expiresAt, attempts } */
const pairingCodes = new Map<string, { expiresAt: number; attempts: number }>();
/** Paired device tokens: token -> { pairedAt, userAgent } */
const deviceTokens = new Map<string, { pairedAt: number; userAgent: string }>();

/** Path to persist device tokens across restarts */
const DEVICE_TOKENS_PATH = join(process.cwd(), ".device-tokens.json");

/** Load device tokens from disk on startup. */
async function loadDeviceTokens(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(DEVICE_TOKENS_PATH, "utf-8"));
    for (const [token, info] of Object.entries(data)) {
      deviceTokens.set(token, info as { pairedAt: number; userAgent: string });
    }
  } catch {
    // File doesn't exist or is invalid -- start fresh
  }
}

/** Save device tokens to disk. */
async function saveDeviceTokens(): Promise<void> {
  const data: Record<string, { pairedAt: number; userAgent: string }> = {};
  for (const [token, info] of deviceTokens) {
    data[token] = info;
  }
  await writeFile(DEVICE_TOKENS_PATH, JSON.stringify(data), "utf-8");
}

/** Pairing code config */
const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;

const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 10000;

// Purge expired pairing codes every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairingCodes) {
    if (now > data.expiresAt) pairingCodes.delete(code);
  }
}, 60_000);

// ============================================================================
// NGROK MANAGEMENT (standalone -- shared by all integrations)
// ============================================================================

/** ngrok child process handle */
let ngrokProcess: ChildProcess | null = null;
/** Current public ngrok URL */
let ngrokUrl: string | null = null;

/**
 * Start ngrok tunnel on the given port.
 * Polls the local ngrok API for the public HTTPS URL.
 *
 * @param port - Local port to tunnel
 * @returns The public HTTPS URL
 */
export async function startNgrok(port: number): Promise<string> {
  if (ngrokProcess) {
    throw new Error("ngrok is already running");
  }

  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  let ngrokStderr = "";
  const ngrokEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (envVars.NGROK_AUTHTOKEN) {
    ngrokEnv.NGROK_AUTHTOKEN = envVars.NGROK_AUTHTOKEN;
  }

  ngrokProcess = spawn("ngrok", ["http", String(port)], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: ngrokEnv,
  });

  ngrokProcess.stderr?.on("data", (chunk: Buffer) => {
    ngrokStderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    ngrokProcess!.on("error", (err: NodeJS.ErrnoException) => {
      ngrokProcess = null;
      if (err.code === "ENOENT") {
        reject(new Error("ngrok is not installed. Install it from https://ngrok.com/download"));
      } else {
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });
    ngrokProcess!.on("spawn", () => resolve());
  });

  ngrokProcess.on("exit", (code) => {
    console.log(`ngrok exited (code ${code})`);
    ngrokProcess = null;
    ngrokUrl = null;
  });

  const url = await pollNgrokUrl(() => {
    if (ngrokProcess === null || ngrokProcess.exitCode !== null) {
      return ngrokStderr.trim() || "ngrok exited immediately. Run 'ngrok http 8080' manually to see the error.";
    }
    return null;
  });

  ngrokUrl = url;
  await writeEnvKey("TWILIO_WEBHOOK_URL", url);
  console.log(`ngrok tunnel: ${url}`);
  return url;
}

/**
 * Stop the ngrok tunnel.
 */
export function stopNgrok(): void {
  if (ngrokProcess && !ngrokProcess.killed) {
    ngrokProcess.kill("SIGTERM");
  }
  ngrokProcess = null;
  ngrokUrl = null;
}

// ============================================================================
// TWILIO SERVER MANAGEMENT (standalone -- just the voice server process)
// ============================================================================

/** Twilio server child process handle */
let twilioProcess: ChildProcess | null = null;
/** Whether the Twilio voice server is running */
let twilioRunning = false;

/**
 * Start the Twilio voice server.
 * Requires ngrok to be running first (needs the webhook URL).
 * Also updates the TwiML App voice URL if WebRTC is configured.
 *
 * @returns Resolves when the process is spawned
 */
export async function startTwilioServer(): Promise<void> {
  if (twilioRunning) {
    throw new Error("Twilio server is already running");
  }

  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  if (!envVars.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is not set in .env");
  }

  // Update TwiML App voice URL if WebRTC is configured
  const twimlAppSid = envVars.TWILIO_TWIML_APP_SID;
  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  if (ngrokUrl && twimlAppSid && accountSid && envVars.TWILIO_AUTH_TOKEN) {
    try {
      const client = twilioSdk(accountSid, envVars.TWILIO_AUTH_TOKEN);
      await client.applications(twimlAppSid).update({
        voiceUrl: `${ngrokUrl}/twilio/incoming-call`,
        voiceMethod: "POST",
      });
      console.log(`Updated TwiML App voice URL to ${ngrokUrl}/twilio/incoming-call`);
    } catch (err) {
      console.error(`Failed to update TwiML App voice URL: ${err}`);
    }
  }

  // Check WebRTC readiness
  webrtcConfigured = !!(envVars.TWILIO_API_KEY_SID && envVars.TWILIO_API_KEY_SECRET && twimlAppSid);

  // Start the Twilio server (pass dashboard port so it can proxy non-Twilio requests)
  twilioProcess = spawn("npx", ["tsx", "sidecar/twilio-server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DASHBOARD_PORT: String(dashboardPort) },
  });

  twilioProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[twilio-server] ${chunk.toString()}`);
  });
  twilioProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[twilio-server] ${chunk.toString()}`);
  });

  twilioProcess.on("exit", (code) => {
    if (twilioRunning) {
      console.error(`Twilio server exited unexpectedly (code ${code})`);
    }
    twilioRunning = false;
    twilioProcess = null;
  });

  twilioRunning = true;
  console.log("Twilio server started.");
}

/**
 * Stop the Twilio voice server.
 */
export function stopTwilioServer(): void {
  if (twilioProcess && !twilioProcess.killed) {
    twilioProcess.kill("SIGTERM");
  }
  twilioProcess = null;
  twilioRunning = false;
}

/**
 * Return the combined status for the dashboard UI.
 *
 * @returns Status object with ngrok URL, server running state, and WebRTC readiness
 */
function getStatus(): { running: boolean; ngrokUrl: string | null; webrtcReady: boolean } {
  return { running: twilioRunning, ngrokUrl, webrtcReady: webrtcConfigured };
}

/**
 * Poll ngrok's local API to discover the public HTTPS tunnel URL.
 * Retries every NGROK_POLL_INTERVAL_MS for up to NGROK_POLL_TIMEOUT_MS.
 * If checkEarlyExit returns a non-null string, aborts immediately with that error.
 *
 * @param checkEarlyExit - Returns an error message if ngrok exited, null otherwise
 * @param apiPort - ngrok local API port (default 4040)
 * @returns The public HTTPS URL
 */
async function pollNgrokUrl(checkEarlyExit: () => string | null, apiPort: number = 4040): Promise<string> {
  const deadline = Date.now() + NGROK_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Check if ngrok died before we even got a tunnel URL
    const earlyExitError = checkEarlyExit();
    if (earlyExitError) {
      throw new Error(earlyExitError);
    }

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
      if (res.ok) {
        const data = await res.json();
        const tunnel = data.tunnels?.find((t: { public_url: string }) => t.public_url.startsWith("https://"));
        if (tunnel) {
          return tunnel.public_url;
        }
      }
    } catch {
      // ngrok not ready yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, NGROK_POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for ngrok tunnel URL");
}

/**
 * Update a single key in the .env file, preserving all other values.
 *
 * @param key - The env variable name to set
 * @param value - The value to write
 */
async function writeEnvKey(key: string, value: string): Promise<void> {
  const content = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(content);
  envVars[key] = value;
  const lines = Object.entries(envVars).map(([k, v]) => `${k}=${v}`);
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

// ============================================================================
// CONVERSATION TYPES
// ============================================================================

/** Summary of a conversation session returned by the list endpoint */
interface ConversationSummary {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  messageCount: number;
}

/** A single conversation turn (user or assistant) */
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

// ============================================================================
// CONVERSATION HANDLERS
// ============================================================================

/**
 * List all conversation sessions with a summary.
 * GET /api/conversations
 *
 * @param res - Server response
 * @returns Array of ConversationSummary sorted by most recent first
 */
async function handleListConversations(res: ServerResponse): Promise<void> {
  const files = await readdir(SESSIONS_DIR);
  const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));

  const summaries: ConversationSummary[] = [];

  for (const file of jsonlFiles) {
    const filePath = join(SESSIONS_DIR, file);
    const fileStat = await stat(filePath);
    const sessionId = basename(file, ".jsonl");

    // Read just the first few lines to extract a summary
    const { firstUserMessage, messageCount } = await extractSessionSummary(filePath);

    summaries.push({
      sessionId,
      firstMessage: firstUserMessage,
      timestamp: fileStat.mtime.toISOString(),
      messageCount,
    });
  }

  // Sort by most recent first
  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  sendJson(res, 200, summaries);
}

/**
 * Get all messages for a specific conversation session.
 * GET /api/conversations/:sessionId
 *
 * @param sessionId - The UUID of the session
 * @param res - Server response
 * @returns Array of ConversationMessage for the session
 */
async function handleGetConversation(sessionId: string, res: ServerResponse): Promise<void> {
  const filePath = join(SESSIONS_DIR, `${sessionId}.jsonl`);

  if (!(await fileExists(filePath))) {
    sendJson(res, 404, { error: "Session not found" });
    return;
  }

  const messages = await parseSessionMessages(filePath);
  sendJson(res, 200, messages);
}

/**
 * Read the first user message and count total user/assistant messages in a session file.
 *
 * @param filePath - Absolute path to the JSONL file
 * @returns The first user message text and total message count
 */
async function extractSessionSummary(filePath: string): Promise<{ firstUserMessage: string; messageCount: number }> {
  let firstUserMessage = "(empty)";
  let messageCount = 0;
  let foundFirst = false;

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "user" && entry.type !== "assistant") continue;

      messageCount++;

      if (!foundFirst && entry.type === "user") {
        const content = entry.message?.content;
        if (typeof content === "string") {
          firstUserMessage = content.slice(0, 120);
        }
        foundFirst = true;
      }
    } catch {
      // Skip malformed lines
    }
  }

  return { firstUserMessage, messageCount };
}

/**
 * Parse all user and assistant messages from a session JSONL file.
 * Deduplicates assistant messages by requestId (the SDK emits multiple
 * partial messages with the same requestId as content blocks stream in).
 *
 * @param filePath - Absolute path to the JSONL file
 * @returns Array of ConversationMessage
 */
async function parseSessionMessages(filePath: string): Promise<ConversationMessage[]> {
  const messages: ConversationMessage[] = [];
  const seenUserUuids = new Set<string>();
  const assistantTexts = new Map<string, { text: string; timestamp: string }>();

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);

      if (entry.type === "user" && entry.message?.role === "user") {
        // Deduplicate user messages by uuid
        if (seenUserUuids.has(entry.uuid)) continue;
        seenUserUuids.add(entry.uuid);

        const content = entry.message.content;
        if (typeof content === "string" && content.trim()) {
          messages.push({ role: "user", content, timestamp: entry.timestamp });
        }
        continue;
      }

      if (entry.type === "assistant" && entry.message?.content) {
        // Accumulate text blocks per requestId (last one wins, has most content)
        const requestId = entry.requestId;
        if (!requestId) continue;

        const blocks = entry.message.content;
        if (!Array.isArray(blocks)) continue;

        const textParts: string[] = [];
        for (const block of blocks) {
          if (block.type === "text" && block.text?.trim()) {
            textParts.push(block.text);
          }
        }

        if (textParts.length > 0) {
          const combined = textParts.join("");
          const existing = assistantTexts.get(requestId);
          // Keep the longest version (last partial message has the most content)
          if (!existing || combined.length > existing.text.length) {
            assistantTexts.set(requestId, { text: combined, timestamp: entry.timestamp });
          }
        }
        continue;
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Merge assistant messages into the timeline by inserting after the last user message
  // that precedes them chronologically
  for (const [, { text, timestamp }] of assistantTexts) {
    messages.push({ role: "assistant", content: text, timestamp });
  }

  // Sort by timestamp
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return messages;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if an HTTP request originated from localhost.
 *
 * @param req - Incoming HTTP request
 * @returns True if the request came from 127.0.0.1 or ::1
 */
function isLocalhostRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Extract a Bearer token from the Authorization header.
 *
 * @param req - Incoming HTTP request
 * @returns The token string, or empty string if not present
 */
function getDeviceToken(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  return "";
}

/**
 * Check if a file exists on disk.
 *
 * @param path - Absolute file path
 * @returns True if the file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve a static file from the public directory.
 *
 * @param pathname - URL pathname (e.g. "/index.html")
 * @param res - Server response
 */
async function handleStaticFile(pathname: string, res: ServerResponse): Promise<void> {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = join(PUBLIC_DIR, filePath);

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/**
 * Read the full request body as a string.
 *
 * @param req - Incoming HTTP request
 * @returns The request body as a UTF-8 string
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param res - Server response
 * @param status - HTTP status code
 * @param data - JSON-serializable data
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
