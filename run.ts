/**
 * Top-level orchestrator that boots the dashboard and the voice sidecar.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (file editor UI)
 * - Spawn the voice sidecar as a filtered child process
 * - Aggregate CoreAudio buffer underflow warnings into summary lines
 */

import { spawn } from "child_process";
import { createInterface } from "readline";
import { startDashboard } from "./dashboard/server.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const UNDERFLOW = "buffer underflow";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  // Start dashboard server (independent of voice pipeline)
  await startDashboard();

  // Spawn voice sidecar as a child process
  const child = spawnSidecar();

  // Forward signals
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));

  child.on("exit", (code) => {
    flushUnderflowCount();
    process.exit(code ?? 1);
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

let underflowCount = 0;
let underflowTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Flush accumulated CoreAudio underflow warnings as a single summary line.
 */
function flushUnderflowCount(): void {
  if (underflowCount > 0) {
    process.stderr.write(`[coreaudio] buffer underflow x${underflowCount}\n`);
    underflowCount = 0;
  }
  underflowTimer = null;
}

/**
 * Filter a line of child process output, aggregating underflow warnings.
 *
 * @param line - A single line of output from the child process
 * @param dest - Destination stream (stdout or stderr)
 */
function filterLine(line: string, dest: NodeJS.WritableStream): void {
  if (line.includes(UNDERFLOW)) {
    underflowCount++;
    if (underflowTimer) clearTimeout(underflowTimer);
    underflowTimer = setTimeout(flushUnderflowCount, 2000);
    return;
  }
  flushUnderflowCount();
  dest.write(line + "\n");
}

/**
 * Spawn the voice sidecar child process with filtered stdout/stderr.
 *
 * @returns The spawned child process
 */
function spawnSidecar(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["--import", "tsx", "sidecar/index.ts"], {
    stdio: ["inherit", "pipe", "pipe"],
    env: process.env,
  });

  createInterface({ input: child.stdout! }).on("line", (l) => filterLine(l, process.stdout));
  createInterface({ input: child.stderr! }).on("line", (l) => filterLine(l, process.stderr));

  return child;
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch((err) => {
  console.error(`Startup failed: ${err}`);
  process.exit(1);
});
