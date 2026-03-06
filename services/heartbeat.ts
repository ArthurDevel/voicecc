/**
 * Interval-based heartbeat scheduler for agent check-ins.
 *
 * Spawns a full Claude Code session per heartbeat check so the agent can
 * execute whatever HEARTBEAT.md instructs (check email, calendar, APIs, etc.).
 * When a heartbeat determines the user should be contacted, initiates an
 * outbound Twilio call.
 *
 * - Start/stop a 60-second global interval that checks all enabled agents
 * - Track per-agent check intervals and concurrent-check guards
 * - Spawn Claude Code SDK query() sessions with full tool access
 * - Parse JSON heartbeat responses and initiate outbound calls
 * - Expose last heartbeat results for the API
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { query as claudeQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import twilio from "twilio";
import { listAgents, getAgent, AGENTS_DIR, type Agent } from "./agent-store.js";
import { readEnv } from "./env.js";
import { getTunnelUrl, isTunnelRunning } from "./tunnel.js";
import { isRunning as isTwilioRunning } from "./twilio-manager.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Global check interval in milliseconds (60 seconds) */
const CHECK_INTERVAL_MS = 60_000;

/** Maximum time for a single heartbeat Claude session in milliseconds */
const SESSION_TIMEOUT_MS = 120_000;

/** User-facing prompt sent to the heartbeat Claude session */
const HEARTBEAT_PROMPT = readFileSync(join(__dirname, "..", "init", "defaults", "system-heartbeat.md"), "utf-8").trim();

// ============================================================================
// TYPES
// ============================================================================

/** Result of a single agent heartbeat check */
export interface HeartbeatResult {
  agentId: string;
  shouldCall: boolean;
  reason: string;
  timestamp: number;
}

// ============================================================================
// STATE
// ============================================================================

/** Global setInterval handle */
let intervalTimer: ReturnType<typeof setInterval> | null = null;

/** Last heartbeat result per agent */
let lastResults: Record<string, HeartbeatResult> = {};

/** Last check timestamp per agent (for interval tracking) */
let lastCheckTimes: Record<string, number> = {};

/** Currently running agent IDs (concurrent guard) */
const inFlightChecks = new Set<string>();

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the heartbeat scheduler.
 * Runs checkAllAgents every 60 seconds via setInterval.
 */
export function startHeartbeat(): void {
  if (intervalTimer) return;

  intervalTimer = setInterval(() => {
    checkAllAgents().catch((err) => {
      console.error("[heartbeat] checkAllAgents error:", err);
    });
  }, CHECK_INTERVAL_MS);

  console.log("[heartbeat] scheduler started (60s interval)");
}

/**
 * Stop the heartbeat scheduler.
 * Clears the global interval timer.
 */
export function stopHeartbeat(): void {
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

/**
 * Get the last heartbeat result per agent.
 * Used by the API to expose heartbeat status.
 *
 * @returns Record of agent ID to last HeartbeatResult
 */
export function getHeartbeatStatus(): Record<string, HeartbeatResult> {
  return lastResults;
}

/**
 * Initiate an outbound Twilio call to an agent's phone number.
 * Used by both the heartbeat scheduler and the API "Call Me" route.
 *
 * Flow:
 * 1. Check preconditions (tunnel + Twilio server running)
 * 2. Generate UUID token and register it with the Twilio server process
 * 3. Place outbound call via Twilio SDK with TwiML streaming to our WebSocket
 *
 * @param agent - Full agent data including config with phone number
 * @returns The Twilio call SID
 */
export async function initiateAgentCall(agent: Agent): Promise<string> {
  // Check preconditions
  if (!isTunnelRunning()) {
    throw new Error("Tunnel is not running. Cannot place outbound call.");
  }
  if (!isTwilioRunning()) {
    throw new Error("Twilio server is not running. Cannot place outbound call.");
  }

  const token = randomUUID();
  const envVars = await readEnv();

  const twilioPort = parseInt(envVars.TWILIO_PORT || "8080", 10);
  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const authToken = envVars.TWILIO_AUTH_TOKEN;
  const userPhoneNumber = envVars.USER_PHONE_NUMBER;

  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env");
  }
  if (!userPhoneNumber) {
    throw new Error("USER_PHONE_NUMBER must be set in Settings > General");
  }

  // Register the call token with the Twilio server process
  await registerCallToken(twilioPort, token, agent.id);

  // Get the tunnel URL (strip protocol for WebSocket URL)
  const fullTunnelUrl = getTunnelUrl()!;
  const tunnelHost = fullTunnelUrl.replace(/^https?:\/\//, "");

  // Get the first Twilio phone number on the account
  const client = twilio(accountSid, authToken);
  const numbers = await client.incomingPhoneNumbers.list({ limit: 1 });
  if (numbers.length === 0) {
    throw new Error("No Twilio phone numbers found on the account");
  }
  const fromNumber = numbers[0].phoneNumber;

  // Build TwiML with WebSocket stream
  const twiml = `<Response><Connect><Stream url="wss://${tunnelHost}/media/${token}?agentId=${agent.id}" /></Connect></Response>`;

  // Place the outbound call
  const call = await client.calls.create({
    to: userPhoneNumber,
    from: fromNumber,
    twiml,
  });

  console.log(`[heartbeat] outbound call placed to ${userPhoneNumber} (callSid=${call.sid})`);
  return call.sid;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check all enabled agents and spawn heartbeat sessions for those that are due.
 * Skips agents whose configured interval has not elapsed and agents with
 * in-flight checks (concurrent guard).
 */
async function checkAllAgents(): Promise<void> {
  const summaries = await listAgents();
  const enabledSummaries = summaries.filter((s) => s.enabled);

  if (enabledSummaries.length === 0) return;

  const now = Date.now();

  for (const summary of enabledSummaries) {
    // Skip if interval has not elapsed
    const lastCheck = lastCheckTimes[summary.id] ?? 0;
    const intervalMs = summary.heartbeatIntervalMinutes * 60_000;
    if (now - lastCheck < intervalMs) continue;

    // Skip if already checking this agent
    if (inFlightChecks.has(summary.id)) continue;

    // Load full agent data and spawn check (fire-and-forget)
    const agent = await getAgent(summary.id);
    checkSingleAgent(agent).catch((err) => {
      console.error(`[heartbeat] check failed for agent "${agent.id}":`, err);
    });
  }
}

/**
 * Spawn a Claude Code session to run the heartbeat check for a single agent.
 * Adds the agent to inFlightChecks during execution.
 * Parses the JSON response and initiates a call if shouldCall is true.
 *
 * @param agent - Full agent data with SOUL.md, MEMORY.md, HEARTBEAT.md
 */
async function checkSingleAgent(agent: Agent): Promise<HeartbeatResult> {
  inFlightChecks.add(agent.id);
  lastCheckTimes[agent.id] = Date.now();

  try {
    const result = await runHeartbeatSession(agent);
    lastResults[agent.id] = result;

    console.log(
      `[heartbeat] agent "${agent.id}": shouldCall=${result.shouldCall}, reason="${result.reason}"`,
    );

    if (result.shouldCall) {
      try {
        await initiateAgentCall(agent);
      } catch (err) {
        console.error(`[heartbeat] failed to call agent "${agent.id}":`, err);
      }
    }

    return result;
  } finally {
    inFlightChecks.delete(agent.id);
  }
}

/**
 * Run a Claude Code SDK query() session with the agent's system prompt.
 * Collects assistant text messages and parses the final JSON response.
 * Times out after SESSION_TIMEOUT_MS and treats timeout as shouldCall: false.
 *
 * @param agent - Full agent data
 * @returns Parsed HeartbeatResult
 */
async function runHeartbeatSession(agent: Agent): Promise<HeartbeatResult> {
  const systemPrompt = [agent.soulMd, agent.memoryMd, agent.heartbeatMd].join("\n\n");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), SESSION_TIMEOUT_MS);

  try {
    const messages: SDKMessage[] = [];

    const q = claudeQuery({
      prompt: HEARTBEAT_PROMPT,
      options: {
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        abortController,
        cwd: join(AGENTS_DIR, agent.id),
        stderr: (data: string) => {
          const msg = data.trim();
          if (msg) console.error(`[heartbeat-stderr] ${msg}`);
        },
      },
    });

    for await (const event of q) {
      messages.push(event);
    }

    // Find the last assistant text block
    const jsonText = extractLastAssistantText(messages);
    if (!jsonText) {
      console.error(`[heartbeat] no assistant text found for agent "${agent.id}"`);
      return failSafeResult(agent.id);
    }

    return parseHeartbeatResponse(agent.id, jsonText);
  } catch (err) {
    if (abortController.signal.aborted) {
      console.error(`[heartbeat] session timed out for agent "${agent.id}"`);
    } else {
      console.error(`[heartbeat] session error for agent "${agent.id}":`, err);
    }
    return failSafeResult(agent.id);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract the text content from the last assistant message in the SDK message stream.
 * Scans all messages for assistant-type messages, returns the text from the last one.
 *
 * @param messages - Array of SDK messages from the query session
 * @returns The extracted text string, or null if none found
 */
function extractLastAssistantText(messages: SDKMessage[]): string | null {
  let lastText: string | null = null;

  for (const msg of messages) {
    if (msg.type === "assistant" && msg.message?.content) {
      const blocks = msg.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === "text") {
            lastText = block.text;
          }
        }
      }
    }
  }

  return lastText;
}

/**
 * Parse a heartbeat JSON response string into a HeartbeatResult.
 * Expects a JSON object with shouldCall (boolean) and reason (string).
 * Returns a fail-safe result if parsing fails.
 *
 * @param agentId - Agent identifier for the result
 * @param text - Raw text from the assistant response
 * @returns Parsed HeartbeatResult
 */
function parseHeartbeatResponse(agentId: string, text: string): HeartbeatResult {
  try {
    // Extract JSON from the text (may contain surrounding text)
    const jsonMatch = text.match(/\{[\s\S]*"shouldCall"[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[heartbeat] no JSON found in response for agent "${agentId}": ${text}`);
      return failSafeResult(agentId);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      agentId,
      shouldCall: Boolean(parsed.shouldCall),
      reason: String(parsed.reason || ""),
      timestamp: Date.now(),
    };
  } catch (err) {
    console.error(`[heartbeat] JSON parse error for agent "${agentId}":`, err);
    return failSafeResult(agentId);
  }
}

/**
 * Create a fail-safe HeartbeatResult that does not trigger a call.
 * Used when the session errors, times out, or returns unparseable output.
 *
 * @param agentId - Agent identifier
 * @returns HeartbeatResult with shouldCall: false
 */
function failSafeResult(agentId: string): HeartbeatResult {
  return {
    agentId,
    shouldCall: false,
    reason: "heartbeat check failed or timed out",
    timestamp: Date.now(),
  };
}

/**
 * Register a call token with the Twilio server process via HTTP POST.
 * The Twilio server runs as a separate child process, so we need to
 * communicate via its HTTP endpoint.
 *
 * @param port - Twilio server port
 * @param token - UUID token for the call
 * @param agentId - Agent identifier to associate with the call
 */
async function registerCallToken(port: number, token: string, agentId: string): Promise<void> {
  const body = JSON.stringify({ token, agentId });

  const response = await fetch(`http://localhost:${port}/register-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to register call token: ${response.status} ${response.statusText}`);
  }
}
