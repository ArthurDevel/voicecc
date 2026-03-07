/**
 * Cloudflare quick tunnel process lifecycle management.
 *
 * Uses the `cloudflared` npm package which auto-downloads the correct binary
 * for the current platform (macOS/Linux, Intel/ARM).
 *
 * Responsibilities:
 * - Start a quick tunnel on a given port and capture the public HTTPS URL
 * - Stop the tunnel and clear state
 * - Expose tunnel state (URL, running status, start time)
 */

import { Tunnel } from "cloudflared";
import { writeEnvKey } from "./env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Timeout for waiting for the tunnel URL to appear */
const TUNNEL_URL_TIMEOUT_MS = 30000;

// ============================================================================
// STATE
// ============================================================================

/** Active tunnel instance */
let activeTunnel: Tunnel | null = null;

/** Current public tunnel URL */
let tunnelUrl: string | null = null;

/** Timestamp when tunnel URL was obtained */
let tunnelStartedAt: number | null = null;

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

  const tunnel = Tunnel.quick(`http://localhost:${port}`, { "--protocol": "http2" });
  activeTunnel = tunnel;

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for tunnel URL"));
    }, TUNNEL_URL_TIMEOUT_MS);

    tunnel.once("url", (url: string) => {
      clearTimeout(timeout);
      resolve(url);
    });

    tunnel.once("error", (err: Error) => {
      clearTimeout(timeout);
      activeTunnel = null;
      reject(new Error(`Failed to start cloudflared: ${err.message}`));
    });
  });

  tunnel.on("exit", () => {
    console.log("cloudflared exited");
    activeTunnel = null;
    tunnelUrl = null;
  });

  tunnelUrl = url;
  tunnelStartedAt = Date.now();
  await writeEnvKey("TWILIO_WEBHOOK_URL", url);
  console.log(`Tunnel URL: ${url}`);
  return url;
}

/**
 * Stop the tunnel and clear state.
 */
export function stopTunnel(): void {
  if (activeTunnel) {
    activeTunnel.stop();
  }
  activeTunnel = null;
  tunnelUrl = null;
  tunnelStartedAt = null;
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
