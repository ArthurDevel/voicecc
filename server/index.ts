/**
 * Top-level entry point that boots the dashboard and voice servers.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 * - Start the unified voice server (Twilio + browser audio + dashboard proxy)
 * - Auto-start tunnel if enabled
 * - Auto-start Twilio if enabled (requires tunnel)
 */

// Global error handlers -- must be registered before any async work to prevent
// silent crashes from unhandled promise rejections or uncaught exceptions.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  console.error(err.stack ?? "(no stack trace)");
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  if (reason instanceof Error) {
    console.error(reason.stack ?? "(no stack trace)");
  }
});

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "dotenv";
config({ path: process.env.VOICECC_DIR ? join(process.env.VOICECC_DIR, ".env") : join(homedir(), ".voicecc", ".env") });

import { startDashboard } from "../dashboard/server.js";
import { readEnv } from "./services/env.js";
import { startTunnel, stopTunnel, isTunnelRunning, getTunnelUrl } from "./services/tunnel.js";
import { startTwilioServer } from "./services/twilio-manager.js";

/** Base URL for the Python FastAPI server (for tunnel URL notification) */
const VOICE_SERVER_API_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

/** Path to the Python voice server directory */
const VOICE_SERVER_DIR = join(import.meta.dirname ?? ".", "..", "voice-server");

/** Reference to the Python voice server child process */
let pythonProcess: ChildProcess | null = null;

/** Maximum number of automatic restart attempts after an unexpected crash */
const PYTHON_MAX_RESTART_ATTEMPTS = 5;

/** Delay before attempting a restart (ms) */
const PYTHON_RESTART_DELAY_MS = 3_000;

/** Number of consecutive restart attempts since last successful start */
let pythonRestartAttempts = 0;

/** Whether the Python server was intentionally stopped (skip auto-restart) */
let pythonManuallyStopped = false;

/**
 * Start the Python voice server as a child process.
 * Waits for the health endpoint to respond before returning.
 */
async function startPythonVoiceServer(): Promise<void> {
  const venvPython = join(VOICE_SERVER_DIR, ".venv", "bin", "python");
  if (!existsSync(venvPython)) {
    console.warn(`Python venv not found at ${venvPython} -- voice server will not start`);
    return;
  }

  console.log("Starting Python voice server...");
  pythonProcess = spawn(venvPython, ["server.py"], {
    cwd: VOICE_SERVER_DIR,
    stdio: ["ignore", "inherit", "inherit"],
  });

  pythonProcess.on("exit", (code) => {
    console.error(`Python voice server exited with code ${code}`);
    pythonProcess = null;
    schedulePythonRestart();
  });

  // Wait for health endpoint (up to 15s)
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${VOICE_SERVER_API_URL}/health`);
      if (res.ok) {
        console.log("Python voice server is ready");
        pythonRestartAttempts = 0;
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn("Python voice server did not become healthy within 15s -- continuing anyway");
}

/**
 * Stop the Python voice server child process. Prevents auto-restart.
 */
function stopPythonVoiceServer(): void {
  pythonManuallyStopped = true;
  if (pythonProcess) {
    pythonProcess.kill("SIGTERM");
    pythonProcess = null;
  }
}

/**
 * Schedule an automatic restart of the Python voice server after an unexpected exit.
 * Skips restart if manually stopped or max attempts exceeded.
 */
function schedulePythonRestart(): void {
  if (pythonManuallyStopped) {
    return;
  }

  pythonRestartAttempts++;

  if (pythonRestartAttempts > PYTHON_MAX_RESTART_ATTEMPTS) {
    console.error(`[voice-server] Giving up after ${PYTHON_MAX_RESTART_ATTEMPTS} restart attempts`);
    return;
  }

  console.log(
    `[voice-server] Restarting in ${PYTHON_RESTART_DELAY_MS / 1000}s ` +
    `(attempt ${pythonRestartAttempts}/${PYTHON_MAX_RESTART_ATTEMPTS})...`
  );

  setTimeout(async () => {
    if (pythonManuallyStopped || pythonProcess) {
      return;
    }

    try {
      await startPythonVoiceServer();
      pythonRestartAttempts = 0;
      console.log("[voice-server] Restarted successfully");

      // Re-notify of tunnel URL if tunnel is running
      const currentTunnelUrl = getTunnelUrl();
      if (currentTunnelUrl) {
        try {
          await fetch(`${VOICE_SERVER_API_URL}/config/tunnel-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: currentTunnelUrl }),
          });
        } catch {
          console.warn("[voice-server] Failed to re-notify tunnel URL after restart");
        }
      }
    } catch (err) {
      console.error(`[voice-server] Restart failed: ${err}`);
      schedulePythonRestart();
    }
  }, PYTHON_RESTART_DELAY_MS);
}

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
function writeStatusFile(dashboardPort: number, tunnelUrl: string | null, tunnelError: string | null = null): void {
  const status = {
    dashboardPort,
    tunnelUrl,
    tunnelError,
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

  // Start the Python voice server (voice pipeline + text chat + heartbeat)
  await startPythonVoiceServer();

  const envVars = await readEnv();

  // Write status file early so the CLI can show dashboard info while tunnel starts
  writeStatusFile(dashboardPort, null);

  // Auto-start tunnel if enabled -- tunnel now points at dashboard port
  // so all external traffic goes through dashboard auth
  if (envVars.TUNNEL_ENABLED === "true") {
    try {
      await startTunnel(dashboardPort);
      const tunnelUrl = getTunnelUrl();
      writeStatusFile(dashboardPort, tunnelUrl);

      // Notify Python server of the tunnel URL so it can build TwiML URLs
      if (tunnelUrl) {
        try {
          await fetch(`${VOICE_SERVER_API_URL}/config/tunnel-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: tunnelUrl }),
          });
          console.log(`Notified Python server of tunnel URL: ${tunnelUrl}`);
        } catch (notifyErr) {
          console.warn(`Failed to notify Python server of tunnel URL: ${notifyErr}`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Tunnel auto-start failed: ${errorMsg}`);
      writeStatusFile(dashboardPort, null, errorMsg);
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
    stopPythonVoiceServer();
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
