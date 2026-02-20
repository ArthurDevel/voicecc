/**
 * Twilio voice server process management.
 *
 * Manages the lifecycle of the twilio-server child process:
 * - Start the server with dashboard port and optional ngrok URL
 * - Stop the server
 * - Report running status and WebRTC readiness
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
  webrtcReady: boolean;
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
 * Reads .env for TWILIO_AUTH_TOKEN. If ngrokUrl and TwiML app SID exist,
 * updates the TwiML app voice URL via Twilio SDK.
 * Spawns twilio-server.ts as a child process with DASHBOARD_PORT env var.
 *
 * @param dashboardPort - The dashboard server port (for proxying)
 * @param ngrokUrl - Optional ngrok public URL for webhook configuration
 */
export async function startTwilioServer(dashboardPort: number, ngrokUrl?: string): Promise<void> {
  if (twilioRunning) {
    throw new Error("Twilio server is already running");
  }

  const envVars = await readEnv();

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
 * Get the combined status of the Twilio server.
 * Derives webrtcReady by checking .env for required WebRTC keys.
 *
 * @returns Status with running state and WebRTC readiness
 */
export async function getStatus(): Promise<TwilioStatus> {
  const envVars = await readEnv();
  const webrtcReady = !!(
    envVars.TWILIO_API_KEY_SID &&
    envVars.TWILIO_API_KEY_SECRET &&
    envVars.TWILIO_TWIML_APP_SID
  );
  return { running: twilioRunning, webrtcReady };
}

/**
 * Check whether the Twilio server process is currently alive.
 *
 * @returns True if the server is running
 */
export function isRunning(): boolean {
  return twilioRunning;
}
