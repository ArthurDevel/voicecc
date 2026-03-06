/**
 * Twilio voice server management.
 *
 * Manages the lifecycle of the Twilio server (runs in-process):
 * - Start the server with dashboard port and optional tunnel URL
 * - Stop the server
 * - Report running status
 */

import { readEnv } from "./env.js";
import twilioSdk from "twilio";
import { startTwilioServer as startServer } from "../voice/twilio-server.js";

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
 * Start the Twilio voice server.
 * Reads .env for TWILIO_AUTH_TOKEN. If tunnelUrl exists, updates phone number
 * webhooks via Twilio SDK.
 * Starts the Twilio server in-process.
 *
 * @param dashboardPort - The dashboard server port (for proxying)
 * @param tunnelUrl - Optional tunnel public URL for webhook configuration
 */
export async function startTwilioServer(dashboardPort: number, tunnelUrl?: string): Promise<void> {
  if (twilioRunning) {
    throw new Error("Twilio server is already running");
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

  // Start the Twilio server in-process
  await startServer(dashboardPort);

  twilioRunning = true;
  console.log("Twilio server started.");
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
