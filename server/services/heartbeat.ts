/**
 * Interval-based heartbeat scheduler for agent check-ins.
 *
 * Creates a persistent Claude Code session per heartbeat check so the agent can
 * execute whatever HEARTBEAT.md instructs (check email, calendar, APIs, etc.).
 * When a heartbeat determines the user should be contacted, initiates an
 * outbound Twilio call and hands the live Claude session to the voice session
 * so it retains full context of what it checked.
 *
 * - Start/stop a 60-second global interval that checks all enabled agents
 * - Track per-agent check intervals and concurrent-check guards
 * - Create persistent Claude sessions with full tool access
 * - Parse JSON heartbeat responses and initiate outbound calls
 * - Pass live Claude sessions to the Twilio server for voice call continuity
 * - Expose last heartbeat results for the API
 */

import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import twilio from "twilio";
import { createClaudeSession, type ClaudeSession } from "../voice/claude-session.js";
import { listAgents, getAgent, AGENTS_DIR, type Agent } from "./agent-store.js";
import { readEnv } from "./env.js";
import { getTunnelUrl, isTunnelRunning } from "./tunnel.js";
import { isRunning as isTwilioRunning } from "./twilio-manager.js";
import { setCallClaudeSession } from "../voice/twilio-server.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Global check interval in milliseconds (60 seconds) */
const CHECK_INTERVAL_MS = 60_000;

/** Maximum time for a single heartbeat Claude session in milliseconds */
const SESSION_TIMEOUT_MS = 120_000;

/** User-facing prompt sent to the heartbeat Claude session */
const HEARTBEAT_PROMPT = readFileSync(join(__dirname, "..", "..", "init", "defaults", "system-heartbeat.md"), "utf-8").trim();

/** Default voice system prompt (shared with voice sessions) */
const DEFAULT_SYSTEM_PROMPT = readFileSync(join(__dirname, "..", "..", "init", "defaults", "system.md"), "utf-8").trim();

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
 * 2. Generate UUID token and register it with the Twilio server
 * 3. Optionally attach a live Claude session for voice call continuity
 * 4. Place outbound call via Twilio SDK with TwiML streaming to our WebSocket
 *
 * @param agent - Full agent data including config with phone number
 * @param claudeSession - Optional live Claude session to hand off to the voice call
 * @returns The Twilio call SID
 */
export async function initiateAgentCall(agent: Agent, opts?: { claudeSession?: ClaudeSession; initialPrompt?: string }): Promise<string> {
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

  // Register the call token with the Twilio server (with optional initial prompt)
  await registerCallToken(twilioPort, token, agent.id, opts?.initialPrompt);

  // Attach the live Claude session if provided (heartbeat-initiated calls)
  if (opts?.claudeSession) {
    setCallClaudeSession(token, opts.claudeSession);
  }

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
 * Run a heartbeat check for a single agent using a persistent Claude session.
 * If the check determines shouldCall, keeps the session alive and passes it
 * to the outbound call so the voice session continues with full context.
 *
 * @param agent - Full agent data with SOUL.md, MEMORY.md, HEARTBEAT.md
 */
async function checkSingleAgent(agent: Agent): Promise<HeartbeatResult> {
  inFlightChecks.add(agent.id);
  lastCheckTimes[agent.id] = Date.now();

  let session: ClaudeSession | null = null;

  try {
    const { result, claudeSession } = await runHeartbeatSession(agent);
    session = claudeSession;
    lastResults[agent.id] = result;

    console.log(
      `[heartbeat] agent "${agent.id}": shouldCall=${result.shouldCall}, reason="${result.reason}"`,
    );

    if (result.shouldCall) {
      try {
        // Pass the live session to the call — it will be handed to the voice session
        await initiateAgentCall(agent, { claudeSession: session });
        session = null; // Don't close — voice session owns it now
      } catch (err) {
        console.error(`[heartbeat] failed to call agent "${agent.id}":`, err);
      }
    }

    return result;
  } finally {
    // Close the session if we still own it (shouldCall was false, or call failed)
    if (session) {
      await session.close();
    }
    inFlightChecks.delete(agent.id);
  }
}

/**
 * Run a heartbeat check using a persistent Claude session.
 * Creates the session with the agent's full context (voice instructions +
 * SOUL.md + MEMORY.md + HEARTBEAT.md), sends the heartbeat prompt, and
 * parses the JSON response.
 *
 * Returns both the parsed result and the live session so the caller can
 * decide whether to keep it alive for a voice call.
 *
 * @param agent - Full agent data
 * @returns The heartbeat result and the live Claude session
 */
async function runHeartbeatSession(agent: Agent): Promise<{ result: HeartbeatResult; claudeSession: ClaudeSession }> {
  // Include voice instructions so the session is ready for voice call continuity
  const systemPrompt = [DEFAULT_SYSTEM_PROMPT, agent.soulMd, agent.memoryMd, agent.heartbeatMd].join("\n\n");

  const claudeSession = await createClaudeSession({
    allowedTools: [],
    permissionMode: "bypassPermissions",
    systemPrompt: "",
    customSystemPrompt: systemPrompt,
    cwd: join(AGENTS_DIR, agent.id),
  });

  // Set up a timeout to close the session if it takes too long
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    claudeSession.interrupt();
  }, SESSION_TIMEOUT_MS);

  try {
    // Send the heartbeat prompt and collect the response text
    let responseText = "";
    const eventStream = claudeSession.sendMessage(HEARTBEAT_PROMPT);

    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        responseText += event.content;
      }
      if (event.type === "result") break;
    }

    if (timedOut) {
      console.error(`[heartbeat] session timed out for agent "${agent.id}"`);
      return { result: failSafeResult(agent.id), claudeSession };
    }

    if (!responseText) {
      console.error(`[heartbeat] no response text for agent "${agent.id}"`);
      return { result: failSafeResult(agent.id), claudeSession };
    }

    const result = parseHeartbeatResponse(agent.id, responseText);
    return { result, claudeSession };
  } catch (err) {
    if (timedOut) {
      console.error(`[heartbeat] session timed out for agent "${agent.id}"`);
    } else {
      console.error(`[heartbeat] session error for agent "${agent.id}":`, err);
    }
    return { result: failSafeResult(agent.id), claudeSession };
  } finally {
    clearTimeout(timeout);
  }
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
 * Register a call token with the Twilio server via HTTP POST.
 * Even though the Twilio server now runs in-process, we still use the HTTP
 * endpoint to register tokens since the WebSocket upgrade path validates
 * against the activeCalls map populated by this endpoint.
 *
 * @param port - Twilio server port
 * @param token - UUID token for the call
 * @param agentId - Agent identifier to associate with the call
 */
async function registerCallToken(port: number, token: string, agentId: string, initialPrompt?: string): Promise<void> {
  const body = JSON.stringify({ token, agentId, ...(initialPrompt && { initialPrompt }) });

  const response = await fetch(`http://localhost:${port}/register-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to register call token: ${response.status} ${response.statusText}`);
  }
}
