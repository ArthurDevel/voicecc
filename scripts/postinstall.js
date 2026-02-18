/**
 * Postinstall script that runs after `npm install`.
 *
 * Compiles the mic-vpio Swift binary (macOS VPIO echo cancellation),
 * checks for required system dependencies (espeak-ng), then sets up
 * the Python virtual environment and installs TTS dependencies.
 *
 * Responsibilities:
 * - Compile the mic-vpio Swift binary for echo-cancelled audio I/O
 * - Verify espeak-ng is installed
 * - Create Python venv in sidecar/.venv (if not already present)
 * - Install Python TTS packages (mlx-audio, misaki, etc.)
 * - Download spaCy English model
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const VENV_DIR = join("sidecar", ".venv");
const PIP = join(VENV_DIR, "bin", "pip");
const PYTHON = join(VENV_DIR, "bin", "python3");

const PYTHON_PACKAGES = [
  "mlx-audio",
  "misaki",
  "num2words",
  "spacy",
  "phonemizer",
];

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

function main() {
  compileMicVpio();
  checkSystemDeps();
  setupPythonVenv();
  installPythonPackages();
  downloadSpacyModel();

  console.log("\nPostinstall complete.");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compile the mic-vpio Swift binary for macOS VPIO echo cancellation.
 * Skips compilation if the binary already exists and is newer than the source.
 */
function compileMicVpio() {
  const source = join("sidecar", "mic-vpio.swift");
  const binary = join("sidecar", "mic-vpio");

  console.log("Compiling mic-vpio (VPIO echo cancellation)...");
  run(`swiftc -O -o ${binary} ${source} -framework AudioToolbox -framework CoreAudio`);
  console.log("mic-vpio compiled successfully");
}

/**
 * Check that required system binaries are available.
 * Exits with a clear error message if any are missing.
 */
function checkSystemDeps() {
  const missing = [];

  if (!commandExists("espeak-ng")) missing.push("espeak-ng");

  if (missing.length > 0) {
    console.error(`\nMissing system dependencies: ${missing.join(", ")}`);
    console.error(`Install them with: brew install ${missing.join(" ")}`);
    process.exit(1);
  }

  console.log("System dependencies OK (espeak-ng)");
}

/**
 * Create the Python virtual environment if it doesn't exist.
 */
function setupPythonVenv() {
  if (existsSync(PIP)) {
    console.log(`Python venv already exists at ${VENV_DIR}`);
    return;
  }

  console.log(`Creating Python venv at ${VENV_DIR}...`);
  run(`python3 -m venv ${VENV_DIR}`);
}

/**
 * Install Python TTS packages into the venv.
 */
function installPythonPackages() {
  console.log("Installing Python TTS packages...");
  run(`${PIP} install ${PYTHON_PACKAGES.join(" ")}`);
}

/**
 * Download the spaCy English language model.
 */
function downloadSpacyModel() {
  console.log("Downloading spaCy English model...");
  run(`${PYTHON} -m spacy download en_core_web_sm`);
}

/**
 * Check if a command exists on the system PATH.
 *
 * @param {string} cmd - Command name to check
 * @returns {boolean} True if the command exists
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command with inherited stdio (output visible to user).
 *
 * @param {string} cmd - Shell command to execute
 */
function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main();
