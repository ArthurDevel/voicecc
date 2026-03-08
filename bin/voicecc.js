#!/usr/bin/env node

/**
 * CLI entry point for the voicecc command.
 *
 * - On first run (no .env), launches an interactive setup wizard
 * - Copies CLAUDE.md template on first run
 * - Spawns the dashboard server
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");
const ENV_PATH = join(PKG_ROOT, ".env");

process.chdir(PKG_ROOT);

// ============================================================================
// SETUP WIZARD
// ============================================================================

/**
 * Prompt the user for a single line of input.
 *
 * @param rl - readline interface
 * @param question - the prompt text
 * @returns the user's trimmed answer
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Generate a cryptographically random password (24 URL-safe characters).
 *
 * @returns generated password string
 */
function generatePassword() {
  return randomBytes(18).toString("base64url");
}

/**
 * Run the first-run setup wizard.
 * Prompts for ElevenLabs API key and dashboard password configuration.
 * Writes results to .env.
 */
async function runSetupWizard() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log("========================================");
  console.log("       Welcome to VoiceCC Setup!        ");
  console.log("========================================");
  console.log("");

  // ElevenLabs API key
  console.log("VoiceCC uses ElevenLabs for speech recognition and text-to-speech.");
  console.log("You can get a free API key at: https://elevenlabs.io");
  console.log("");
  const apiKey = await ask(rl, "Paste your ElevenLabs API key (or press Enter to skip): ");
  if (!apiKey) {
    console.log("Skipped. You can add it later from the dashboard.");
  }

  // Dashboard password
  console.log("");
  console.log("Would you like to protect your dashboard with a password?");
  console.log("Anyone with access to the dashboard can control your voice agents.");
  console.log("");
  console.log("  1) Yes, generate a password for me (recommended)");
  console.log("  2) No, leave it open (not recommended)");
  console.log("");
  const passwordChoice = await ask(rl, "Choose [1/2]: ");

  let password = "";
  if (passwordChoice === "2") {
    console.log("");
    console.log("WARNING: Your dashboard will be open to anyone who can reach it.");
  } else {
    password = generatePassword();
    console.log("");
    console.log("========================================");
    console.log("  Your dashboard login (save this!)     ");
    console.log("========================================");
    console.log("");
    console.log(`  Username: admin`);
    console.log(`  Password: ${password}`);
    console.log("");
    console.log("  \x1b[31mThis will NOT be shown again.\x1b[0m");
    console.log("  Your browser will ask for these when");
    console.log("  you open the dashboard.");
    console.log("========================================");
    console.log("");
    await ask(rl, "Have you saved the password? Press Enter to continue. ");
  }

  // Tunnel
  console.log("");
  console.log("Would you like to enable a public tunnel (via Cloudflare)?");
  console.log("This is required if you want to access VoiceCC on a remote");
  console.log("server, and/or want to make use of phone calling.");
  console.log("");
  console.log("  1) Yes, enable tunnel (recommended)");
  console.log("  2) No, local only");
  console.log("");
  const tunnelChoice = await ask(rl, "Choose [1/2]: ");
  const tunnelEnabled = tunnelChoice !== "2";
  if (tunnelEnabled) {
    console.log("Tunnel will start automatically on boot.");
  } else {
    console.log("Tunnel disabled. You can enable it later from Settings.");
  }

  rl.close();

  // Build .env content
  const lines = [];
  if (apiKey) lines.push(`ELEVENLABS_API_KEY=${apiKey}`);
  if (password) lines.push(`DASHBOARD_PASSWORD=${password}`);
  lines.push(`TUNNEL_ENABLED=${tunnelEnabled}`);
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf-8");

  console.log("All done! Starting VoiceCC...");
  console.log("");
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

// Copy CLAUDE.md template if available
const claudeMdSrc = join("init", "CLAUDE.md");
if (existsSync(claudeMdSrc)) {
  copyFileSync(claudeMdSrc, "CLAUDE.md");
}

// Run setup wizard on first run (no .env file)
if (!existsSync(ENV_PATH)) {
  await runSetupWizard();
}

// Start the dashboard
const child = spawn(TSX_BIN, ["server/index.ts"], {
  cwd: PKG_ROOT,
  stdio: "inherit",
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code) => process.exit(code ?? 1));
