/**
 * On-demand setup for local TTS (Kokoro via mlx-audio).
 *
 * Extracted from postinstall.js so local model installation is no longer
 * required at npm-install time. The dashboard triggers this on demand
 * when the user selects the local TTS provider.
 *
 * Responsibilities:
 * - Compile mic-vpio Swift binary (macOS VPIO echo cancellation)
 * - Check for espeak-ng system dependency
 * - Create Python virtual environment
 * - Install mlx-audio and related Python packages
 * - Download spaCy English model
 * - Report whether local TTS is already installed
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
const MIC_VPIO = join("sidecar", "mic-vpio");

const PYTHON_PACKAGES = [
  "mlx-audio",
  "misaki",
  "num2words",
  "spacy",
  "phonemizer",
];

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Run the full local TTS setup sequence.
 *
 * Steps: check platform -> compile mic-vpio -> check espeak-ng ->
 * create Python venv -> install packages -> download spaCy model.
 *
 * @throws {Error} If any setup step fails, with an actionable message
 */
export function setupLocalTts() {
  if (process.platform !== "darwin") {
    throw new Error(
      "Local TTS requires macOS with Apple Silicon. " +
      "Set TTS_PROVIDER=elevenlabs in .env to use a cloud provider instead."
    );
  }

  try {
    compileMicVpio();
  } catch (err) {
    throw new Error(`Failed to compile mic-vpio: ${err.message}`);
  }

  try {
    checkSystemDeps();
  } catch (err) {
    throw new Error(`Missing system dependencies: ${err.message}`);
  }

  try {
    setupPythonVenv();
  } catch (err) {
    throw new Error(`Failed to create Python venv: ${err.message}`);
  }

  try {
    installPythonPackages();
  } catch (err) {
    throw new Error(`Failed to install Python packages: ${err.message}`);
  }

  try {
    downloadSpacyModel();
  } catch (err) {
    throw new Error(`Failed to download spaCy model: ${err.message}`);
  }

  console.log("Local TTS setup complete.");
}

/**
 * Check whether local TTS is already installed.
 *
 * @returns {boolean} True if both the Python venv and mic-vpio binary exist
 */
export function isLocalTtsInstalled() {
  return existsSync(PYTHON) && existsSync(MIC_VPIO);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compile the mic-vpio Swift binary for macOS VPIO echo cancellation.
 *
 * @throws {Error} If swiftc is not found or compilation fails
 */
function compileMicVpio() {
  if (existsSync(MIC_VPIO)) {
    console.log("mic-vpio already compiled, skipping.");
    return;
  }

  const source = join("sidecar", "mic-vpio.swift");

  if (!commandExists("swiftc")) {
    throw new Error(
      "Swift compiler (swiftc) not found. " +
      "Install Xcode Command Line Tools: xcode-select --install"
    );
  }

  console.log("Compiling mic-vpio (VPIO echo cancellation)...");
  run(`swiftc -O -o ${MIC_VPIO} ${source} -framework AudioToolbox -framework CoreAudio`);
  console.log("mic-vpio compiled successfully.");
}

/**
 * Check that required system dependencies (espeak-ng) are installed.
 *
 * @throws {Error} If espeak-ng is not found
 */
function checkSystemDeps() {
  if (!commandExists("espeak-ng")) {
    throw new Error(
      "espeak-ng is not installed. Install with: brew install espeak-ng"
    );
  }
  console.log("System dependencies OK (espeak-ng).");
}

/**
 * Create the Python virtual environment if it does not exist.
 *
 * @throws {Error} If python3 is not found or venv creation fails
 */
function setupPythonVenv() {
  if (existsSync(PIP)) {
    console.log(`Python venv already exists at ${VENV_DIR}.`);
    return;
  }

  if (!commandExists("python3")) {
    throw new Error(
      "python3 not found. Install Python 3 via: brew install python3"
    );
  }

  console.log(`Creating Python venv at ${VENV_DIR}...`);
  run(`python3 -m venv ${VENV_DIR}`);
}

/**
 * Install required Python packages into the virtual environment.
 *
 * @throws {Error} If pip install fails
 */
function installPythonPackages() {
  console.log("Installing Python TTS packages...");
  run(`${PIP} install ${PYTHON_PACKAGES.join(" ")}`);
}

/**
 * Download the spaCy English language model.
 *
 * @throws {Error} If spaCy download fails
 */
function downloadSpacyModel() {
  console.log("Downloading spaCy English model...");
  run(`${PYTHON} -m spacy download en_core_web_sm`);
}

/**
 * Check whether a command exists on the system PATH.
 *
 * @param {string} cmd - Command name to look up
 * @returns {boolean} True if the command is found
 */
function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a shell command synchronously with inherited stdio.
 *
 * @param {string} cmd - Shell command to execute
 */
function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}
