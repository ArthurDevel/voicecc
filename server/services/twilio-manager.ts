/**
 * Twilio integration state management.
 *
 * Simplified: tracks whether Twilio is enabled and checks the Python voice
 * server health. The actual Twilio call handling (WebSocket, TwiML, heartbeat)
 * runs in the Python server.
 *
 * Responsibilities:
 * - Track Twilio running state
 * - Update Twilio phone number webhooks on start
 * - Check Python server health via GET /health
 */

import { readEnv } from "./env.js";
import twilioSdk from "twilio";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Base URL for the Python FastAPI server */
const VOICE_API_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

// ============================================================================
// TYPES
// ============================================================================

/** Twilio server status for the dashboard UI */
export interface TwilioStatus {
  running: boolean;
}

// ============================================================================
// STATE
// ============================================================================

/** Whether the Twilio integration is running */
let twilioRunning = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the Twilio integration.
 * Checks Python server health, then updates phone number webhooks via Twilio SDK.
 *
 * @param _dashboardPort - Unused (kept for API compatibility)
 * @param tunnelUrl - Optional tunnel public URL for webhook configuration
 */
export async function startTwilioServer(_dashboardPort: number, tunnelUrl?: string): Promise<void> {
  if (twilioRunning) {
    throw new Error("Twilio is already running");
  }

  // Check Python server health
  try {
    const healthRes = await fetch(`${VOICE_API_URL}/health`);
    if (!healthRes.ok) {
      throw new Error(`Python server returned ${healthRes.status}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Python voice server is not reachable at ${VOICE_API_URL}: ${msg}`);
  }

  const envVars = await readEnv();

  if (!envVars.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is not set in .env");
  }

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const webhookUrl = tunnelUrl ? `${tunnelUrl}/api/twilio/incoming-call` : null;

  if (tunnelUrl && accountSid && envVars.TWILIO_AUTH_TOKEN) {
    const client = twilioSdk(accountSid, envVars.TWILIO_AUTH_TOKEN);

    // Update all phone numbers on the account to point to the new webhook URL
    try {
      const numbers = await client.incomingPhoneNumbers.list();
      for (const num of numbers) {
        await client.incomingPhoneNumbers(num.sid).update({
          voiceUrl: webhookUrl!,
          voiceMethod: "POST",
        });
      }
      if (numbers.length > 0) {
        console.log(`Updated ${numbers.length} phone number(s) webhook to ${webhookUrl}`);
      }
    } catch (err) {
      console.error(`Failed to update phone number webhooks: ${err}`);
    }
  }

  twilioRunning = true;
  console.log("Twilio integration started.");
}

/**
 * Stop the Twilio voice server.
 */
export function stopTwilioServer(): void {
  twilioRunning = false;
}

/**
 * Get the status of the Twilio server.
 *
 * @returns Status with running state
 */
export async function getStatus(): Promise<TwilioStatus> {
  return { running: twilioRunning };
}

/**
 * Check whether the Twilio server process is currently alive.
 *
 * @returns True if the server is running
 */
export function isRunning(): boolean {
  return twilioRunning;
}
