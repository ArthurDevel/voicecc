/**
 * Top-level entry point that boots the dashboard server.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Auto-start enabled integrations (Twilio, Browser Call) with tunnel as dependency
 */

import { startDashboard } from "./dashboard/server.js";
import { readEnv } from "./services/env.js";
import { startTunnel, isTunnelRunning } from "./services/tunnel.js";
import { startTwilioServer } from "./services/twilio-manager.js";
import { startBrowserCallServer } from "./services/browser-call-manager.js";

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
  const tunnelPort = parseInt(envVars.TWILIO_PORT || "8080", 10);

  // Auto-start Twilio if enabled
  if (envVars.TWILIO_ENABLED === "true") {
    console.log("Twilio integration enabled, starting...");
    try {
      if (!isTunnelRunning()) {
        await startTunnel(tunnelPort);
      }
      await startTwilioServer(port, undefined);
    } catch (err) {
      console.error(`Twilio auto-start failed: ${err}`);
    }
  }

  // Auto-start Browser Call if enabled
  if (envVars.BROWSER_CALL_ENABLED === "true") {
    console.log("Browser Call integration enabled, starting...");
    try {
      if (!isTunnelRunning()) {
        await startTunnel(tunnelPort);
      }
      await startBrowserCallServer(port);
    } catch (err) {
      console.error(`Browser Call auto-start failed: ${err}`);
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
