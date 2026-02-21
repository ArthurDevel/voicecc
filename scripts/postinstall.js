/**
 * Setup script for voicecc.
 *
 * Compiles the mic-vpio Swift binary (macOS VPIO echo cancellation),
 * checks for required system dependencies (espeak-ng), then sets up
 * the Python virtual environment and installs TTS dependencies.
 *
 * Called from bin/voicecc.js on first run (or when setup is incomplete).
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync } from "fs";
import { join } from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const VENV_DIR = join("sidecar", ".venv");
const PIP = join(VENV_DIR, "bin", "pip");
const PYTHON = join(VENV_DIR, "bin", "python3");
const MIC_VPIO = join("sidecar", "mic-vpio");

const PYTHON_PACKAGES = [
  "mlx-audio",
  "misaki",
  "num2words",
  "spacy",
  "phonemizer",
];

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Returns true if any setup step is incomplete.
 */
export function needsSetup() {
  return (
    !existsSync(MIC_VPIO) ||
    !existsSync(PYTHON) ||
    !existsSync(join("dashboard", "dist", "index.html"))
  );
}

/**
 * Run all setup steps. Shows progress to stdout.
 */
export function runSetup() {
  installClaudeMd();
  buildDashboard();
  compileMicVpio();
  checkSystemDeps();
  setupPythonVenv();
  installPythonPackages();
  downloadSpacyModel();

  console.log("");
  console.log("========================================");
  console.log("          VOICECC SETUP COMPLETE        ");
  console.log("========================================");
  console.log("");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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

function installClaudeMd() {
  const src = join("init", "CLAUDE.md");
  const dest = "CLAUDE.md";

  if (!existsSync(src)) {
    return;
  }

  copyFileSync(src, dest);
  console.log("Installed CLAUDE.md to project root.");
}

function compileMicVpio() {
  if (existsSync(MIC_VPIO)) {
    console.log("mic-vpio already compiled, skipping.");
    return;
  }

  const source = join("sidecar", "mic-vpio.swift");

  if (process.platform !== "darwin") {
    console.error("\n[voicecc] ERROR: macOS is required.");
    console.error("  voicecc uses macOS VPIO for echo cancellation and mlx-audio for TTS.");
    console.error("  It cannot run on Linux or Windows.\n");
    process.exit(1);
  }

  if (!commandExists("swiftc")) {
    console.error("\n[voicecc] ERROR: Swift compiler (swiftc) not found.");
    console.error("  Install Xcode Command Line Tools: xcode-select --install\n");
    process.exit(1);
  }

  console.log("Compiling mic-vpio (VPIO echo cancellation)...");
  try {
    run(`swiftc -O -o ${MIC_VPIO} ${source} -framework AudioToolbox -framework CoreAudio`);
  } catch (err) {
    console.error("\n[voicecc] ERROR: Failed to compile mic-vpio.swift.");
    console.error("  Make sure Xcode Command Line Tools are installed: xcode-select --install\n");
    process.exit(1);
  }
  console.log("mic-vpio compiled successfully");
}

function checkSystemDeps() {
  const missing = [];

  if (!commandExists("espeak-ng")) missing.push("espeak-ng");

  if (missing.length > 0) {
    console.error(`\n[voicecc] ERROR: Missing system dependencies: ${missing.join(", ")}`);
    console.error(`  Install with: brew install ${missing.join(" ")}`);
    console.error(`  Then re-run: voicecc\n`);
    process.exit(1);
  }

  console.log("System dependencies OK (espeak-ng)");
}

function setupPythonVenv() {
  if (existsSync(PIP)) {
    console.log(`Python venv already exists at ${VENV_DIR}`);
    return;
  }

  if (!commandExists("python3")) {
    console.error("\n[voicecc] ERROR: python3 not found.");
    console.error("  Install Python 3 via: brew install python3\n");
    process.exit(1);
  }

  console.log(`Creating Python venv at ${VENV_DIR}...`);
  try {
    run(`python3 -m venv ${VENV_DIR}`);
  } catch (err) {
    console.error("\n[voicecc] ERROR: Failed to create Python virtual environment.");
    console.error("  Make sure python3 is installed: brew install python3\n");
    process.exit(1);
  }
}

function installPythonPackages() {
  console.log("Installing Python TTS packages...");
  try {
    run(`${PIP} install ${PYTHON_PACKAGES.join(" ")}`);
  } catch (err) {
    console.error("\n[voicecc] ERROR: Failed to install Python TTS packages.");
    console.error("  This may be due to missing build tools or incompatible Python version.");
    console.error("  Required packages: " + PYTHON_PACKAGES.join(", "));
    console.error("  Try deleting sidecar/.venv and re-running: voicecc\n");
    process.exit(1);
  }
}

function downloadSpacyModel() {
  console.log("Downloading spaCy English model...");
  try {
    run(`${PYTHON} -m spacy download en_core_web_sm`);
  } catch (err) {
    console.error("\n[voicecc] ERROR: Failed to download spaCy English model.");
    console.error("  Try manually: sidecar/.venv/bin/python3 -m spacy download en_core_web_sm\n");
    process.exit(1);
  }
}

function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}
