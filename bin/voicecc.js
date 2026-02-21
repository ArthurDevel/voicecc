#!/usr/bin/env node

/**
 * CLI entry point for the voicecc command.
 *
 * Resolves the package install directory and spawns `tsx run.ts`
 * with inherited stdio so the dashboard server runs in the foreground.
 *
 * Responsibilities:
 * - Resolve the package root from this script's location
 * - Spawn tsx with run.ts in the correct working directory
 * - Forward signals (SIGINT, SIGTERM) so Ctrl+C stops the server cleanly
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const child = spawn(TSX_BIN, ["run.ts"], {
  cwd: PKG_ROOT,
  stdio: "inherit",
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code) => process.exit(code ?? 1));
