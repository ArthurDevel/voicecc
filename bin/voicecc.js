#!/usr/bin/env node

/**
 * CLI entry point for the voicecc command.
 *
 * Checks if first-run setup is needed (compile mic-vpio, Python venv, etc.)
 * and runs it with visible output. Then spawns `tsx run.ts` for the dashboard.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");

// Run setup if needed (first run or incomplete install)
process.chdir(PKG_ROOT);
const { needsSetup, runSetup } = await import("../scripts/postinstall.js");

if (needsSetup()) {
  console.log("[voicecc] Running first-time setup...\n");
  runSetup();
}

// Start the dashboard
const child = spawn(TSX_BIN, ["run.ts"], {
  cwd: PKG_ROOT,
  stdio: "inherit",
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code) => process.exit(code ?? 1));
