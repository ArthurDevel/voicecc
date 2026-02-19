/**
 * Top-level entry point that boots the dashboard server.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Auto-start ngrok if NGROK_AUTHTOKEN is configured in .env
 * - Auto-start Twilio server if TWILIO_AUTH_TOKEN is configured in .env
 */

import { startDashboard, startNgrok, startTwilioServer } from "./dashboard/server.js";
import { readFile } from "fs/promises";
import { join } from "path";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  await startDashboard();
  console.log("Dashboard ready. Use the 'Start Voice' button to begin a voice session.");

  const envContent = await readFile(join(process.cwd(), ".env"), "utf-8").catch(() => "");
  const envVars = parseEnvLines(envContent);

  // Auto-start ngrok if authtoken is configured
  if (envVars.NGROK_AUTHTOKEN) {
    const port = parseInt(envVars.TWILIO_PORT || "8080", 10);
    console.log("ngrok authtoken detected, starting ngrok tunnel...");
    try {
      await startNgrok(port);
    } catch (err) {
      console.error(`ngrok auto-start failed: ${err}`);
    }
  }

  // Auto-start Twilio server if auth token is configured
  if (envVars.TWILIO_AUTH_TOKEN) {
    console.log("Twilio auth token detected, starting Twilio server...");
    try {
      await startTwilioServer();
    } catch (err) {
      console.error(`Twilio server auto-start failed: ${err}`);
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse .env file content into a key-value record.
 *
 * @param content - Raw .env file content
 * @returns Record of key-value pairs
 */
function parseEnvLines(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (value) result[key] = value;
  }
  return result;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch((err) => {
  console.error(`Startup failed: ${err}`);
  process.exit(1);
});
