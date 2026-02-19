/**
 * Top-level entry point that boots the dashboard server.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Auto-start Twilio server + ngrok if TWILIO_AUTH_TOKEN is configured in .env
 */

import { startDashboard, startTwilio } from "./dashboard/server.js";
import { readFile } from "fs/promises";
import { join } from "path";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  await startDashboard();
  console.log("Dashboard ready. Use the 'Start Voice' button to begin a voice session.");

  // Auto-start Twilio if auth token is configured
  const envContent = await readFile(join(process.cwd(), ".env"), "utf-8").catch(() => "");
  const hasAuthToken = envContent.split("\n").some((line) => {
    const [key, ...rest] = line.split("=");
    return key.trim() === "TWILIO_AUTH_TOKEN" && rest.join("=").trim().length > 0;
  });

  if (hasAuthToken) {
    console.log("Twilio auth token detected, starting Twilio server + ngrok...");
    try {
      await startTwilio();
    } catch (err) {
      console.error(`Twilio auto-start failed: ${err}`);
    }
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch((err) => {
  console.error(`Startup failed: ${err}`);
  process.exit(1);
});
