/**
 * Top-level entry point that boots the dashboard and voice servers.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Start the unified voice server (Twilio + browser audio + dashboard proxy)
 * - Auto-start tunnel if enabled
 * - Auto-start Twilio if enabled (requires tunnel)
 */

import "dotenv/config";

import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { startDashboard } from "../dashboard/server.js";
import { readEnv } from "./services/env.js";
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelUrl } from "./services/tunnel.js";
import { startTwilioServer } from "./services/twilio-manager.js";
import { startHeartbeat } from "./services/heartbeat.js";
import { startVoiceServer } from "./voice/voice-server.js";

// Use VOICECC_DIR env var if set (passed by CLI when dropping root privileges),
// otherwise fall back to ~/.voicecc.
const VOICECC_DIR = process.env.VOICECC_DIR ?? join(homedir(), ".voicecc");
const STATUS_FILE = join(VOICECC_DIR, "status.json");

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Write server status to ~/.voicecc/status.json so the CLI can display info.
 *
 * @param dashboardPort - the port the dashboard is running on
 * @param tunnelUrl - the tunnel URL, or null if disabled
 */
function writeStatusFile(dashboardPort: number, tunnelUrl: string | null): void {
  const status = {
    dashboardPort,
    tunnelUrl,
    startedAt: new Date().toISOString(),
  };
  try {
    mkdirSync(VOICECC_DIR, { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {
    console.error("Failed to write status file");
  }
}

/**
 * Remove the status file on shutdown.
 */
function cleanupStatusFile(): void {
  try { unlinkSync(STATUS_FILE); } catch { /* ignore */ }
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  const dashboardPort = await startDashboard();
  const voicePort = await startVoiceServer(dashboardPort);

  startHeartbeat();

  const envVars = await readEnv();

  // Write status file early so the CLI can show dashboard info while tunnel starts
  writeStatusFile(dashboardPort, null);

  // Auto-start tunnel if enabled (independent of integrations)
  if (envVars.TUNNEL_ENABLED === "true") {
    try {
      await startTunnel(voicePort);
      writeStatusFile(dashboardPort, getTunnelUrl());
    } catch (err) {
      console.error(`Tunnel auto-start failed: ${err}`);
      writeStatusFile(dashboardPort, null);
    }
  }

  // Auto-start Twilio if enabled
  if (envVars.TWILIO_ENABLED === "true") {
    console.log("Twilio integration enabled, starting...");
    if (!isTunnelRunning()) {
      console.error("Twilio auto-start failed: Tunnel is not enabled. Enable it in Settings > General.");
    } else {
      try {
        await startTwilioServer(dashboardPort, getTunnelUrl() ?? undefined);
      } catch (err) {
        console.error(`Twilio auto-start failed: ${err}`);
      }
    }
  }

  // Graceful shutdown: stop tunnel subprocess, then clean up status file
  const shutdown = () => {
    stopTunnel();
    cleanupStatusFile();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Print startup banner
  const finalTunnelUrl = getTunnelUrl();
  console.log("");
  console.log("========================================");
  console.log("             VOICECC RUNNING            ");
  console.log("========================================");
  console.log("");
  console.log(`  Dashboard:  http://localhost:${dashboardPort}`);
  console.log(`  Tunnel:     ${finalTunnelUrl ?? "disabled"}`);
  console.log("");
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch((err) => {
  console.error(`Startup failed: ${err}`);
  process.exit(1);
});
