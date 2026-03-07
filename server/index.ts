/**
 * Top-level entry point that boots the dashboard and voice servers.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Start the unified voice server (Twilio + browser audio + dashboard proxy)
 * - Auto-start enabled integrations (Twilio, Browser Call) with tunnel as dependency
 */

import { startDashboard } from "../dashboard/server.js";
import { readEnv } from "./services/env.js";
import { startTunnel, isTunnelRunning, getTunnelUrl } from "./services/tunnel.js";
import { startTwilioServer } from "./services/twilio-manager.js";
import { startBrowserCallServer } from "./services/browser-call-manager.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { startVoiceServer } from "./voice/voice-server.js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  const dashboardPort = await startDashboard();
  const voicePort = await startVoiceServer(dashboardPort);

  console.log("");
  console.log("========================================");
  console.log("             VOICECC RUNNING            ");
  console.log("========================================");
  console.log("");
  console.log(`  Dashboard:  http://localhost:${dashboardPort}`);
  console.log(`  Voice:      http://localhost:${voicePort}`);
  console.log("  Press Ctrl+C to stop.");
  console.log("");

  startHeartbeat();

  const envVars = await readEnv();

  // Auto-start Twilio if enabled
  if (envVars.TWILIO_ENABLED === "true") {
    console.log("Twilio integration enabled, starting...");
    try {
      if (!isTunnelRunning()) {
        await startTunnel(voicePort);
      }
      await startTwilioServer(dashboardPort, getTunnelUrl() ?? undefined);
    } catch (err) {
      console.error(`Twilio auto-start failed: ${err}`);
    }
  }

  // Auto-start Browser Call if enabled
  if (envVars.BROWSER_CALL_ENABLED === "true") {
    console.log("Browser Call integration enabled, starting...");
    try {
      if (!isTunnelRunning()) {
        await startTunnel(voicePort);
      }
      await startBrowserCallServer(dashboardPort);
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
