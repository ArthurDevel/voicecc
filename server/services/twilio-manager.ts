/**
 * Twilio integration state management.
 *
 * Tracks whether the Twilio integration is enabled/active and handles
 * Twilio-specific setup (webhook URL updates). The actual HTTP/WebSocket
 * handling runs in the unified voice server (voice-server.ts).
 */

import { readEnv } from "./env.js";
import twilioSdk from "twilio";

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

/** Whether the Twilio voice server is running */
let twilioRunning = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the Twilio integration.
 * Reads .env for TWILIO_AUTH_TOKEN. If tunnelUrl exists, updates phone number
 * webhooks via Twilio SDK. The voice server is already running and handles
 * Twilio HTTP/WebSocket requests.
 *
 * @param _dashboardPort - Unused (kept for API compatibility)
 * @param tunnelUrl - Optional tunnel public URL for webhook configuration
 */
export async function startTwilioServer(_dashboardPort: number, tunnelUrl?: string): Promise<void> {
  if (twilioRunning) {
    throw new Error("Twilio is already running");
  }

  const envVars = await readEnv();

  if (!envVars.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_AUTH_TOKEN is not set in .env");
  }

  const accountSid = envVars.TWILIO_ACCOUNT_SID;
  const webhookUrl = tunnelUrl ? `${tunnelUrl}/twilio/incoming-call` : null;

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
  // In-process server doesn't have a clean shutdown mechanism yet;
  // mark as not running so new calls are rejected.
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
