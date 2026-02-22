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
  return !existsSync(join("dashboard", "dist", "index.html"));
}

/**
 * Run all setup steps. Shows progress to stdout.
 */
export function runSetup() {
  installClaudeMd();
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
