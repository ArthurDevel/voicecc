#!/usr/bin/env node

/**
 * CLI entry point for the voicecc command.
 *
 * Copies CLAUDE.md on first run, then spawns the dashboard server.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");

process.chdir(PKG_ROOT);

// Copy CLAUDE.md template if available
const claudeMdSrc = join("init", "CLAUDE.md");
if (existsSync(claudeMdSrc)) {
  copyFileSync(claudeMdSrc, "CLAUDE.md");
}

// Start the dashboard
const child = spawn(TSX_BIN, ["server/index.ts"], {
  cwd: PKG_ROOT,
  stdio: "inherit",
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code) => process.exit(code ?? 1));
