/**
 * ngrok process lifecycle management.
 *
 * Manages spawning and stopping the ngrok tunnel process:
 * - Start ngrok on a given port and poll for the public HTTPS URL
 * - Stop ngrok and clear state
 * - Check if ngrok is installed
 * - Configure ngrok authtoken
 */

import { spawn, execFile, ChildProcess } from "child_process";
import { readEnv, writeEnvKey } from "./env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const NGROK_POLL_INTERVAL_MS = 500;
const NGROK_POLL_TIMEOUT_MS = 10000;

// ============================================================================
// STATE
// ============================================================================

/** ngrok child process handle */
let ngrokProcess: ChildProcess | null = null;

/** Current public ngrok URL */
let ngrokUrl: string | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Start ngrok tunnel on the given port.
 * Polls the local ngrok API for the public HTTPS URL, writes it to .env
 * as TWILIO_WEBHOOK_URL, and returns it.
 *
 * @param port - Local port to tunnel
 * @returns The public HTTPS URL
 */
export async function startNgrok(port: number): Promise<string> {
  if (ngrokProcess) {
    throw new Error("ngrok is already running");
  }

  // Check if another ngrok instance is already running (port 4040)
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels");
    if (res.ok) {
      throw new Error(
        "Another ngrok instance is already running on port 4040. " +
        "Stop it first (e.g. 'killall ngrok') before starting a new tunnel."
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Another ngrok")) throw err;
    // Connection refused = no existing ngrok, good to proceed
  }

  const envVars = await readEnv();

  let ngrokStderr = "";
  const ngrokEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (envVars.NGROK_AUTHTOKEN) {
    ngrokEnv.NGROK_AUTHTOKEN = envVars.NGROK_AUTHTOKEN;
  }

  ngrokProcess = spawn("ngrok", ["http", String(port)], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
    env: ngrokEnv,
  });

  ngrokProcess.stderr?.on("data", (chunk: Buffer) => {
    ngrokStderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    ngrokProcess!.on("error", (err: NodeJS.ErrnoException) => {
      ngrokProcess = null;
      if (err.code === "ENOENT") {
        reject(new Error("ngrok is not installed. Install it from https://ngrok.com/download"));
      } else {
        reject(new Error(`Failed to start ngrok: ${err.message}`));
      }
    });
    ngrokProcess!.on("spawn", () => resolve());
  });

  ngrokProcess.on("exit", (code) => {
    console.log(`ngrok exited (code ${code})`);
    ngrokProcess = null;
    ngrokUrl = null;
  });

  const url = await pollNgrokUrl(() => {
    if (ngrokProcess === null || ngrokProcess.exitCode !== null) {
      return ngrokStderr.trim() || "ngrok exited immediately. Run 'ngrok http 8080' manually to see the error.";
    }
    return null;
  });

  ngrokUrl = url;
  await writeEnvKey("TWILIO_WEBHOOK_URL", url);
  console.log(`ngrok tunnel: ${url}`);
  return url;
}

/**
 * Stop the ngrok tunnel and clear state.
 */
export function stopNgrok(): void {
  if (ngrokProcess && !ngrokProcess.killed) {
    ngrokProcess.kill("SIGTERM");
  }
  ngrokProcess = null;
  ngrokUrl = null;
}

/**
 * Return the current public ngrok URL, or null if not running.
 *
 * @returns The public HTTPS URL or null
 */
export function getNgrokUrl(): string | null {
  return ngrokUrl;
}

/**
 * Check whether the ngrok process is currently alive.
 *
 * @returns True if ngrok is running
 */
export function isNgrokRunning(): boolean {
  return ngrokProcess !== null && !ngrokProcess.killed;
}

/**
 * Check if ngrok is installed by running `ngrok version`.
 *
 * @returns True if ngrok is installed
 */
export async function checkNgrokInstalled(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const child = execFile("ngrok", ["version"], (err) => resolve(!err));
      child.on("error", () => {}); // Suppress duplicate error event
    } catch {
      resolve(false);
    }
  });
}

/**
 * Configure ngrok authtoken by running `ngrok config add-authtoken`.
 *
 * @param token - The ngrok authtoken to configure
 * @returns Result with ok status and output message
 */
export async function configureNgrokAuthtoken(token: string): Promise<{ ok: boolean; output: string }> {
  return new Promise<{ ok: boolean; output: string }>((resolve) => {
    try {
      const child = execFile("ngrok", ["config", "add-authtoken", token.trim()], (err, stdout, stderr) => {
        resolve({ ok: !err, output: (stdout || stderr || "").trim() });
      });
      child.on("error", () => resolve({ ok: false, output: "ngrok is not installed" }));
    } catch {
      resolve({ ok: false, output: "Failed to run ngrok" });
    }
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Poll ngrok's local API to discover the public HTTPS tunnel URL.
 * Retries every NGROK_POLL_INTERVAL_MS for up to NGROK_POLL_TIMEOUT_MS.
 *
 * @param checkEarlyExit - Returns an error message if ngrok exited, null otherwise
 * @param apiPort - ngrok local API port (default 4040)
 * @returns The public HTTPS URL
 */
async function pollNgrokUrl(checkEarlyExit: () => string | null, apiPort: number = 4040): Promise<string> {
  const deadline = Date.now() + NGROK_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const earlyExitError = checkEarlyExit();
    if (earlyExitError) {
      throw new Error(earlyExitError);
    }

    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/tunnels`);
      if (res.ok) {
        const data = await res.json();
        const tunnel = data.tunnels?.find((t: { public_url: string }) => t.public_url.startsWith("https://"));
        if (tunnel) {
          return tunnel.public_url;
        }
      }
    } catch {
      // ngrok not ready yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, NGROK_POLL_INTERVAL_MS));
  }

  throw new Error("Timed out waiting for ngrok tunnel URL");
}
