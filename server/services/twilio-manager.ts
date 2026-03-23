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

  if (!envVars.TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER is not set in .env");
  }

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const webhookUrl = tunnelUrl ? `${tunnelUrl}/api/twilio/incoming-call` : null;

  if (tunnelUrl && accountSid && envVars.TWILIO_AUTH_TOKEN) {
    const client = twilioSdk(accountSid, envVars.TWILIO_AUTH_TOKEN);

    // Update the selected phone number's webhook URL
    const selectedNumber = envVars.TWILIO_PHONE_NUMBER;
    try {
      if (selectedNumber) {
        // Find the SID for the selected number and update only that one
        const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: selectedNumber });
        if (numbers.length > 0) {
          await client.incomingPhoneNumbers(numbers[0].sid).update({
            voiceUrl: webhookUrl!,
            voiceMethod: "POST",
          });
          console.log(`Updated webhook for ${selectedNumber} to ${webhookUrl}`);
        } else {
          console.error(`Selected phone number ${selectedNumber} not found on Twilio account`);
        }
      } else {
        console.warn("No TWILIO_PHONE_NUMBER configured, skipping webhook setup");
      }
    } catch (err) {
      console.error(`Failed to update phone number webhook: ${err}`);
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
