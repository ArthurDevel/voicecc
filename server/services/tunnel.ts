/**
 * Cloudflare quick tunnel process lifecycle management.
 *
 * Uses the `cloudflared` npm package which auto-downloads the correct binary
 * for the current platform (macOS/Linux, Intel/ARM).
 *
 * Responsibilities:
 * - Start a quick tunnel on a given port and capture the public HTTPS URL
 * - Auto-restart the tunnel on unexpected crashes (up to MAX_RESTART_ATTEMPTS)
 * - Log connection-level events (connected/disconnected) for observability
 * - Stop the tunnel and clear state
 * - Expose tunnel state (URL, running status, start time)
 */

import { Tunnel } from "cloudflared";
import { writeEnvKey } from "./env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Timeout for waiting for the tunnel URL to appear */
const TUNNEL_URL_TIMEOUT_MS = 15_000;

/** Maximum number of automatic restart attempts after an unexpected crash */
const MAX_RESTART_ATTEMPTS = 5;

/** Delay before attempting a restart (ms) */
const RESTART_DELAY_MS = 3_000;

// ============================================================================
// STATE
// ============================================================================

/** Active tunnel instance */
let activeTunnel: Tunnel | null = null;

/** Current public tunnel URL */
let tunnelUrl: string | null = null;

/** Timestamp when tunnel URL was obtained */
let tunnelStartedAt: number | null = null;

/** Port used for the current tunnel (needed for auto-restart) */
let tunnelPort: number | null = null;

/** Number of consecutive restart attempts since last successful start */
let restartAttempts = 0;

/** Whether the tunnel was intentionally stopped (skip auto-restart) */
let manuallyStopped = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start a Cloudflare quick tunnel on the given port.
 * The cloudflared binary is auto-downloaded if not already present.
 * Writes the public URL to .env as TWILIO_WEBHOOK_URL.
 *
 * @param port - Local port to tunnel
 * @returns The public HTTPS URL
 */
export async function startTunnel(port: number): Promise<string> {
  if (activeTunnel) {
    throw new Error("Tunnel is already running");
  }

  manuallyStopped = false;
  tunnelPort = port;

  const url = await createTunnel(port);

  // Reset restart counter on successful start
  restartAttempts = 0;

  tunnelUrl = url;
  tunnelStartedAt = Date.now();
  await writeEnvKey("TWILIO_WEBHOOK_URL", url);
  console.log(`Tunnel URL: ${url}`);
  return url;
}

/**
 * Stop the tunnel and clear state. Prevents auto-restart.
 */
export function stopTunnel(): void {
  manuallyStopped = true;
  if (activeTunnel) {
    activeTunnel.stop();
  }
  clearTunnelState();
}

/**
 * Return the current public tunnel URL, or null if not running.
 *
 * @returns The public HTTPS URL or null
 */
export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

/**
 * Return the timestamp when the tunnel URL was obtained, or null.
 *
 * @returns Unix ms timestamp or null
 */
export function getTunnelStartedAt(): number | null {
  return tunnelStartedAt;
}

/**
 * Check whether the tunnel process is currently alive.
 *
 * @returns True if tunnel is running
 */
export function isTunnelRunning(): boolean {
  return activeTunnel !== null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create a new tunnel instance, wait for its URL, and attach event handlers.
 *
 * @param port - Local port to tunnel
 * @returns The public HTTPS URL
 */
async function createTunnel(port: number): Promise<string> {
  const tunnel = Tunnel.quick(`http://localhost:${port}`);
  activeTunnel = tunnel;

  // Log cloudflared output for debugging
  tunnel.on("stdout", (data: string) => {
    console.log(`[cloudflared] ${data.trim()}`);
  });
  tunnel.on("stderr", (data: string) => {
    console.log(`[cloudflared] ${data.trim()}`);
  });

  // Log connection-level events for observability
  tunnel.on("connected", (conn: { id: string; ip: string; location: string }) => {
    console.log(`[cloudflared] Connected: ${conn.location} (${conn.ip})`);
  });
  tunnel.on("disconnected", (conn: { id: string; ip: string; location: string }) => {
    console.log(`[cloudflared] Disconnected: ${conn.location} (${conn.ip})`);
  });

  // Wait for the tunnel URL or fail
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      activeTunnel = null;
      reject(new Error("Timed out waiting for tunnel URL (15s)"));
    }, TUNNEL_URL_TIMEOUT_MS);

    tunnel.once("url", (emittedUrl: string) => {
      clearTimeout(timeout);
      resolve(emittedUrl);
    });

    tunnel.once("error", (err: Error) => {
      clearTimeout(timeout);
      activeTunnel = null;
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });

    tunnel.once("exit", () => {
      clearTimeout(timeout);
      activeTunnel = null;
      reject(new Error("cloudflared exited before emitting a URL"));
    });
  });

  // After successful start, handle unexpected exit with auto-restart
  tunnel.on("exit", () => {
    console.log("cloudflared exited unexpectedly");
    clearTunnelState();
    scheduleRestart();
  });

  return url;
}

/**
 * Clear all tunnel state variables.
 */
function clearTunnelState(): void {
  activeTunnel = null;
  tunnelUrl = null;
  tunnelStartedAt = null;
}

/**
 * Schedule an automatic restart if the tunnel crashed unexpectedly.
 * Skips restart if the tunnel was manually stopped or max attempts exceeded.
 */
function scheduleRestart(): void {
  if (manuallyStopped) {
    return;
  }

  if (tunnelPort === null) {
    console.error("[tunnel] Cannot restart: no port configured");
    return;
  }

  restartAttempts++;

  if (restartAttempts > MAX_RESTART_ATTEMPTS) {
    console.error(`[tunnel] Giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
    return;
  }

  const port = tunnelPort;
  console.log(`[tunnel] Restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`);

  setTimeout(async () => {
    if (manuallyStopped || activeTunnel) {
      return;
    }

    try {
      const url = await createTunnel(port);
      restartAttempts = 0;
      tunnelUrl = url;
      tunnelStartedAt = Date.now();
      await writeEnvKey("TWILIO_WEBHOOK_URL", url);
      console.log(`[tunnel] Restarted successfully: ${url}`);
    } catch (err) {
      console.error(`[tunnel] Restart failed: ${err}`);
      scheduleRestart();
    }
  }, RESTART_DELAY_MS);
}
