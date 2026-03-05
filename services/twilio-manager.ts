/**
 * Twilio voice server process management.
 *
 * Manages the lifecycle of the twilio-server child process:
 * - Start the server with dashboard port and optional tunnel URL
 * - Stop the server
 * - Report running status
 */

import { spawn, ChildProcess } from "child_process";
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

/** Twilio server child process handle */
let twilioProcess: ChildProcess | null = null;

/** Whether the Twilio voice server is running */
let twilioRunning = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the Twilio voice server.
 * Reads .env for TWILIO_AUTH_TOKEN. If tunnelUrl and TwiML app SID exist,
 * updates the TwiML app voice URL via Twilio SDK.
 * Spawns twilio-server.ts as a child process with DASHBOARD_PORT env var.
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

    // Update TwiML App voice URL if configured
    const twimlAppSid = envVars.TWILIO_TWIML_APP_SID;
    if (twimlAppSid) {
      try {
        await client.applications(twimlAppSid).update({
          voiceUrl: webhookUrl!,
          voiceMethod: "POST",
        });
        console.log(`Updated TwiML App voice URL to ${webhookUrl}`);
      } catch (err) {
        console.error(`Failed to update TwiML App voice URL: ${err}`);
      }
    }

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
