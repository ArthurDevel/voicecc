/**
 * Top-level entry point that boots the dashboard server.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Auto-start ngrok if NGROK_AUTHTOKEN is configured in .env
 * - Auto-start Twilio server if TWILIO_AUTH_TOKEN is configured in .env
 */

import { startDashboard } from "./dashboard/server.js";
import { readEnv } from "./services/env.js";
import { startNgrok } from "./services/ngrok.js";
import { startTwilioServer } from "./services/twilio-manager.js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  const port = await startDashboard();

  console.log("");
  console.log("========================================");
  console.log("             VOICECC RUNNING            ");
  console.log("========================================");
  console.log("");
  console.log(`  Dashboard:  http://localhost:${port}`);
  console.log("  Press Ctrl+C to stop.");
  console.log("");

  const envVars = await readEnv();

  // Auto-start ngrok if authtoken is configured
  let ngrokUrl: string | undefined;
  if (envVars.NGROK_AUTHTOKEN) {
    const ngrokPort = parseInt(envVars.TWILIO_PORT || "8080", 10);
    console.log("ngrok authtoken detected, starting ngrok tunnel...");
    try {
      ngrokUrl = await startNgrok(ngrokPort);
    } catch (err) {
      console.error(`ngrok auto-start failed: ${err}`);
    }
  }

  // Auto-start Twilio server if auth token is configured
  if (envVars.TWILIO_AUTH_TOKEN) {
    console.log("Twilio auth token detected, starting Twilio server...");
    try {
      await startTwilioServer(port, ngrokUrl);
    } catch (err) {
      console.error(`Twilio server auto-start failed: ${err}`);
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
