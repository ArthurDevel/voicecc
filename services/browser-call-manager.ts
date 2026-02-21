/**
 * Browser call server process management.
 *
 * Manages the lifecycle of the browser-server child process.
 * Analogous to twilio-manager.ts but simpler -- no TwiML app updates,
 * no Twilio SDK dependency.
 *
 * Responsibilities:
 * - Spawn browser-server.ts as a child process with DASHBOARD_PORT env var
 * - Stop the server via SIGTERM
 * - Report running status
 */

import { spawn, ChildProcess } from "child_process";

// ============================================================================
// TYPES
// ============================================================================

/** Browser call server status for the dashboard UI */
export interface BrowserCallStatus {
  /** Whether the browser-server process is alive */
  running: boolean;
}

// ============================================================================
// STATE
// ============================================================================

/** Browser server child process handle */
let browserProcess: ChildProcess | null = null;

/** Whether the browser call server is running */
let browserRunning = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start the browser call server.
 * Spawns browser-server.ts as a child process with DASHBOARD_PORT env var.
 * Uses TWILIO_PORT from .env (default 8080).
 *
 * @param dashboardPort - The dashboard server port (for proxying)
 * @throws Error if the server is already running
 */
export async function startBrowserCallServer(dashboardPort: number): Promise<void> {
  if (browserRunning) {
    throw new Error("Browser call server is already running");
  }

  browserProcess = spawn("npx", ["tsx", "sidecar/browser-server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DASHBOARD_PORT: String(dashboardPort) },
  });

  browserProcess.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(`[browser-server] ${chunk.toString()}`);
  });
  browserProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[browser-server] ${chunk.toString()}`);
  });

  browserProcess.on("exit", (code) => {
    if (browserRunning) {
      console.error(`Browser call server exited unexpectedly (code ${code})`);
    }
    browserRunning = false;
    browserProcess = null;
  });

  browserRunning = true;
  console.log("Browser call server started.");
}

/**
 * Stop the browser call server.
 * Sends SIGTERM to the child process and clears state.
 */
export function stopBrowserCallServer(): void {
  if (browserProcess && !browserProcess.killed) {
    browserProcess.kill("SIGTERM");
  }
  browserProcess = null;
  browserRunning = false;
}

/**
 * Get the status of the browser call server.
 *
 * @returns Status with running state
 */
export function getBrowserCallStatus(): BrowserCallStatus {
  return { running: browserRunning };
}

/**
 * Check whether the browser call server process is currently alive.
 *
 * @returns True if the server is running
 */
export function isBrowserCallRunning(): boolean {
  return browserRunning;
}
