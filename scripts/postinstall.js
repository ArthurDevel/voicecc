/**
 * Postinstall setup script for voicecc.
 *
 * Lightweight first-run setup that installs the CLAUDE.md file
 * and builds the dashboard. Local TTS/STT model installation is
 * handled on demand via setup-local-tts.js and setup-local-stt.js.
 *
 * Called from bin/voicecc.js on first run (or when setup is incomplete).
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { join } from "path";

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Returns true if any setup step is incomplete.
 * Only checks whether the dashboard has been built.
 *
 * @returns {boolean} True if setup is needed
 */
export function needsSetup() {
  const dashboardMissing = !existsSync(join("dashboard", "dist", "index.html"));
  const micVpioMissing = process.platform === "darwin" && !existsSync(join("server", "voice", "mic-vpio"));
  return dashboardMissing || micVpioMissing;
}

/**
 * Run all setup steps. Shows progress to stdout.
 */
export function runSetup() {
  installClaudeMd();
  buildMicVpio();
  buildDashboard();

  console.log("");
  console.log("========================================");
  console.log("           SETUP COMPLETE               ");
  console.log("========================================");
  console.log("");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compile the native mic-vpio audio binary (macOS only).
 */
function buildMicVpio() {
  const bin = join("server", "voice", "mic-vpio");
  if (existsSync(bin)) {
    console.log("mic-vpio already compiled, skipping.");
    return;
  }
  if (process.platform !== "darwin") {
    console.log("Skipping mic-vpio (macOS only).");
    return;
  }
  console.log("Compiling mic-vpio...");
  try {
    run("swiftc -O -o server/voice/mic-vpio server/voice/mic-vpio.swift -framework AudioToolbox -framework CoreAudio");
  } catch (err) {
    console.error("\n[voicecc] WARNING: Failed to compile mic-vpio.");
    console.error("  Terminal voice mode will not work. Browser/phone calling is unaffected.");
    console.error("  Try manually: swiftc -O -o server/voice/mic-vpio server/voice/mic-vpio.swift -framework AudioToolbox -framework CoreAudio\n");
    return;
  }
  console.log("mic-vpio compiled successfully.");
}

/**
 * Build the dashboard Vite app if not already built.
 */
function buildDashboard() {
  if (existsSync(join("dashboard", "dist", "index.html"))) {
    console.log("Dashboard already built, skipping.");
    return;
  }
  console.log("Building dashboard...");
  try {
    run("cd dashboard && npx vite build");
  } catch (err) {
    console.error("\n[voicecc] ERROR: Failed to build dashboard.");
    console.error("  Try manually: cd dashboard && npx vite build\n");
    process.exit(1);
  }
  console.log("Dashboard built successfully");
}

/**
 * Copy the CLAUDE.md template from init/ to the project root.
 */
function installClaudeMd() {
  const src = join("init", "CLAUDE.md");
  const dest = "CLAUDE.md";

  if (!existsSync(src)) {
    return;
  }

  copyFileSync(src, dest);
  console.log("Installed CLAUDE.md to project root.");
}

/**
 * Run a shell command synchronously with inherited stdio.
 *
 * @param {string} cmd - Shell command to execute
 */
function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}
