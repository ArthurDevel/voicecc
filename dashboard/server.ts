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
      sendJson(res, 200, getTwilioStatus());
    } else if (pathname === "/api/twilio/start" && req.method === "POST") {
      await handleTwilioStart(res);
    } else if (pathname === "/api/twilio/stop" && req.method === "POST") {
      await handleTwilioStop(res);
    } else if (pathname === "/api/twilio/check-ngrok" && req.method === "GET") {
      await handleCheckNgrok(res);
    } else if (pathname === "/api/twilio/ngrok-authtoken" && req.method === "POST") {
      await handleNgrokAuthtoken(req, res);
    } else if (pathname === "/api/twilio/phone-numbers" && req.method === "GET") {
      await handleGetPhoneNumbers(res);
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
  for (const key of ["TWILIO_AUTH_TOKEN", "NGROK_AUTHTOKEN"]) {
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
    if ((key === "TWILIO_AUTH_TOKEN" || key === "NGROK_AUTHTOKEN") && value.startsWith("****")) {
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
 * Start the Twilio server and ngrok.
 * POST /api/twilio/start
 *
 * @param res - Server response
 */
async function handleTwilioStart(res: ServerResponse): Promise<void> {
  try {
    await startTwilio();
    sendJson(res, 200, { success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start Twilio";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Stop the Twilio server and ngrok.
 * POST /api/twilio/stop
 *
 * @param res - Server response
 */
async function handleTwilioStop(res: ServerResponse): Promise<void> {
  await stopTwilio();
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

// ============================================================================
// TWILIO PROCESS MANAGEMENT
// ============================================================================

/** ngrok child process handle */
let ngrokProcess: ChildProcess | null = null;
/** Twilio server child process handle */
let twilioProcess: ChildProcess | null = null;
/** Current Twilio status exposed via the REST API */
let twilioStatus: { running: boolean; ngrokUrl: string | null; error: string | null } = {
  running: false,
  ngrokUrl: null,
  error: null,
};

const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 10000;

/**
 * Start ngrok and the Twilio server.
 * Reads TWILIO_AUTH_TOKEN and TWILIO_PORT from .env. Spawns ngrok, polls for
 * the public HTTPS URL, writes it back to .env as TWILIO_WEBHOOK_URL, then
 * spawns the Twilio server process.
 *
 * @returns Resolves when both processes are running
 */
export async function startTwilio(): Promise<void> {
  if (twilioStatus.running) {
    throw new Error("Twilio server is already running");
  }

  // Read .env and validate auth token
  const envContent = await readFile(ENV_PATH, "utf-8").catch(() => "");
  const envVars = parseEnvFile(envContent);

  if (!envVars.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is not set in .env");
  }

  const port = envVars.TWILIO_PORT || "8080";

  // Start ngrok -- capture stderr so we can report errors
  let ngrokStderr = "";
  const ngrokEnv: Record<string, string> = { ...process.env as Record<string, string> };
  if (envVars.NGROK_AUTHTOKEN) {
    ngrokEnv.NGROK_AUTHTOKEN = envVars.NGROK_AUTHTOKEN;
  }
  ngrokProcess = spawn("ngrok", ["http", port], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: ngrokEnv,
  });

  ngrokProcess.stderr?.on("data", (chunk: Buffer) => {
    ngrokStderr += chunk.toString();
  });

  // Wait for ngrok to either start successfully or fail to spawn
  await new Promise<void>((resolve, reject) => {
    ngrokProcess!.on("error", (err: NodeJS.ErrnoException) => {
      ngrokProcess = null;
      if (err.code === "ENOENT") {
        reject(new Error("ngrok is not installed. Install it from https://ngrok.com/download"));
      } else {
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });
    // If the process spawns without immediate error, continue
    ngrokProcess!.on("spawn", () => resolve());
  });

  ngrokProcess.on("exit", (code) => {
    if (twilioStatus.running) {
      twilioStatus = { running: false, ngrokUrl: null, error: `ngrok exited unexpectedly (code ${code})` };
      stopTwilio();
    }
  });

  // Poll ngrok local API for the public HTTPS URL.
  // Pass a callback to detect if ngrok exited early.
  const ngrokUrl = await pollNgrokUrl(() => {
    if (ngrokProcess === null || ngrokProcess.exitCode !== null) {
      const hint = ngrokStderr.trim();
      return hint || "ngrok exited immediately. Run 'ngrok http 8080' manually to see the error.";
    }
    return null;
  });

  // Write the detected URL back to .env
  await writeEnvKey("TWILIO_WEBHOOK_URL", ngrokUrl);

  // Start the Twilio server
  twilioProcess = spawn("npx", ["tsx", "sidecar/twilio-server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  twilioProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[twilio-server] ${chunk.toString()}`);
  });
  twilioProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[twilio-server] ${chunk.toString()}`);
  });

  twilioProcess.on("exit", (code) => {
    if (twilioStatus.running) {
      twilioStatus = { running: false, ngrokUrl: null, error: `Twilio server exited unexpectedly (code ${code})` };
      stopTwilio();
    }
  });

  twilioStatus = { running: true, ngrokUrl, error: null };
  console.log(`Twilio server started. ngrok URL: ${ngrokUrl}`);
}

/**
 * Stop both the Twilio server and ngrok processes.
 *
 * @returns Resolves when both processes are killed
 */
export async function stopTwilio(): Promise<void> {
  if (twilioProcess && !twilioProcess.killed) {
    twilioProcess.kill("SIGTERM");
  }
  twilioProcess = null;

  if (ngrokProcess && !ngrokProcess.killed) {
    ngrokProcess.kill("SIGTERM");
  }
  ngrokProcess = null;

  twilioStatus = { running: false, ngrokUrl: null, error: null };
}

/**
 * Return the current Twilio server status.
 *
 * @returns Status object with running state, ngrok URL, and any error
 */
function getTwilioStatus(): { running: boolean; ngrokUrl: string | null; error: string | null } {
  return twilioStatus;
}

/**
 * Poll ngrok's local API to discover the public HTTPS tunnel URL.
 * Retries every NGROK_POLL_INTERVAL_MS for up to NGROK_POLL_TIMEOUT_MS.
 * If checkEarlyExit returns a non-null string, aborts immediately with that error.
 *
 * @param checkEarlyExit - Returns an error message if ngrok exited, null otherwise
 * @returns The public HTTPS URL
 */
async function pollNgrokUrl(checkEarlyExit: () => string | null): Promise<string> {
  const deadline = Date.now() + NGROK_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    // Check if ngrok died before we even got a tunnel URL
    const earlyExitError = checkEarlyExit();
    if (earlyExitError) {
      await stopTwilio();
      throw new Error(earlyExitError);
    }

    try {
      const res = await fetch("http://127.0.0.1:4040/api/tunnels");
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

  // Timed out -- clean up ngrok
  await stopTwilio();
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
