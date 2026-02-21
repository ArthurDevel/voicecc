/**
 * Cloudflare quick tunnel process lifecycle management.
 *
 * Manages spawning and stopping the cloudflared tunnel process:
 * - Start cloudflared on a given port and parse the public HTTPS URL from stderr
 * - Stop cloudflared and clear state
 * - Check if cloudflared is installed
 */

import { spawn, execFile, ChildProcess } from "child_process";
import { writeEnvKey } from "./env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Timeout for waiting for the tunnel URL to appear in stderr */
const TUNNEL_URL_TIMEOUT_MS = 30000;

// ============================================================================
// STATE
// ============================================================================

/** cloudflared child process handle */
let tunnelProcess: ChildProcess | null = null;

/** Current public tunnel URL */
let tunnelUrl: string | null = null;

/** Timestamp when tunnel URL was obtained */
let tunnelStartedAt: number | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start a Cloudflare quick tunnel on the given port.
 * Parses the public HTTPS URL from cloudflared's stderr output,
 * writes it to .env as TWILIO_WEBHOOK_URL, and returns it.
 *
 * @param port - Local port to tunnel
 * @returns The public HTTPS URL
 */
export async function startTunnel(port: number): Promise<string> {
  if (tunnelProcess) {
    throw new Error("Tunnel is already running");
  }

  let tunnelStderr = "";

  tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--protocol", "http2"], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });

  tunnelProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    tunnelStderr += text;
    for (const line of text.split("\n")) {
      if (line.trim()) {
        console.log(`[tunnel] ${line}`);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    tunnelProcess!.on("error", (err: NodeJS.ErrnoException) => {
      tunnelProcess = null;
      if (err.code === "ENOENT") {
        reject(new Error(
          "cloudflared is not installed. Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ or: brew install cloudflared"
        ));
      } else {
        reject(new Error(`Failed to start cloudflared: ${err.message}`));
      }
    });
    tunnelProcess!.on("spawn", () => resolve());
  });

  tunnelProcess.on("exit", (code) => {
    console.log(`cloudflared exited (code ${code})`);
    tunnelProcess = null;
    tunnelUrl = null;
  });

  // Parse the tunnel URL from stderr
  const url = await parseTunnelUrl(() => {
    if (tunnelProcess === null || tunnelProcess.exitCode !== null) {
      return tunnelStderr.trim() || "cloudflared exited immediately. Run 'cloudflared tunnel --url http://localhost:8080' manually to see the error.";
    }
    return null;
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
  if (tunnelProcess && !tunnelProcess.killed) {
    tunnelProcess.kill("SIGTERM");
  }
  tunnelProcess = null;
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
  return tunnelProcess !== null && !tunnelProcess.killed;
}

/**
 * Check if cloudflared is installed by running `cloudflared version`.
 *
 * @returns True if cloudflared is installed
 */
export async function checkCloudflaredInstalled(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile("cloudflared", ["version"], (err) => resolve(!err));
      child.on("error", () => {}); // Suppress duplicate error event
    } catch {
      resolve(false);
    }
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Wait for and parse the tunnel URL from cloudflared's stderr output.
 * cloudflared prints the URL as: https://<random>.trycloudflare.com
 *
 * @param checkEarlyExit - Returns an error message if cloudflared exited, null otherwise
 * @returns The public HTTPS URL
 */
async function parseTunnelUrl(checkEarlyExit: () => string | null): Promise<string> {
  const deadline = Date.now() + TUNNEL_URL_TIMEOUT_MS;

  return new Promise<string>((resolve, reject) => {
    // Listen for the URL in stderr output
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        tunnelProcess?.stderr?.off("data", onData);
        clearInterval(checkInterval);
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };

    tunnelProcess?.stderr?.on("data", onData);

    // Periodically check for early exit
    const checkInterval = setInterval(() => {
      const earlyExitError = checkEarlyExit();
      if (earlyExitError) {
        tunnelProcess?.stderr?.off("data", onData);
        clearInterval(checkInterval);
        clearTimeout(timeout);
        reject(new Error(earlyExitError));
      }
    }, 500);

    // Timeout
    const timeout = setTimeout(() => {
      tunnelProcess?.stderr?.off("data", onData);
      clearInterval(checkInterval);
      reject(new Error("Timed out waiting for tunnel URL"));
    }, TUNNEL_URL_TIMEOUT_MS);
  });
}
