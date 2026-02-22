/**
 * On-demand setup for local STT (Whisper ONNX model download).
 *
 * Downloads the sherpa-onnx Whisper small.en model files to
 * ~/.claude-voice-models/whisper-small/. The dashboard triggers this
 * on demand when the user selects the local STT provider.
 *
 * Responsibilities:
 * - Download the Whisper ONNX model archive from sherpa-onnx releases
 * - Extract the required model files (encoder, decoder, tokens)
 * - Report whether the local STT model is already installed
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Directory where Whisper model files are stored */
const MODEL_DIR = join(homedir(), ".claude-voice-models", "whisper-small");

/** URL for the sherpa-onnx Whisper small.en model archive */
const MODEL_URL =
  "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.en.tar.bz2";

/** Archive filename after download */
const ARCHIVE_NAME = "sherpa-onnx-whisper-small.en.tar.bz2";

/** Directory name inside the extracted archive */
const EXTRACTED_DIR_NAME = "sherpa-onnx-whisper-small.en";

/** The 3 required model files for local Whisper STT */
const REQUIRED_FILES = [
  "small.en-encoder.int8.onnx",
  "small.en-decoder.int8.onnx",
  "small.en-tokens.txt",
];

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Download and install the Whisper ONNX model files for local STT.
 *
 * Steps: create model dir -> download archive -> extract -> move files -> cleanup.
 *
 * @throws {Error} If any step fails, with an actionable message
 */
export function setupLocalStt() {
  if (isLocalSttInstalled()) {
    console.log("Local STT model already installed, skipping.");
    return;
  }

  // Ensure model directory exists
  mkdirSync(MODEL_DIR, { recursive: true });

  const archivePath = join(MODEL_DIR, ARCHIVE_NAME);
  const extractedPath = join(MODEL_DIR, EXTRACTED_DIR_NAME);

  try {
    downloadArchive(archivePath);
  } catch (err) {
    throw new Error(`Failed to download Whisper model: ${err.message}`);
  }

  try {
    extractArchive(archivePath);
  } catch (err) {
    throw new Error(`Failed to extract Whisper model archive: ${err.message}`);
  }

  try {
    moveModelFiles(extractedPath);
  } catch (err) {
    throw new Error(`Failed to move model files: ${err.message}`);
  }

  try {
    cleanup(archivePath, extractedPath);
  } catch (err) {
    // Cleanup failures are non-fatal, just log
    console.warn(`Warning: cleanup failed: ${err.message}`);
  }

  console.log("Local STT model setup complete.");
}

/**
 * Check whether the local STT model is already installed.
 *
 * @returns {boolean} True if all 3 required model files exist
 */
export function isLocalSttInstalled() {
  return REQUIRED_FILES.every((file) => existsSync(join(MODEL_DIR, file)));
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Download the model archive using curl.
 *
 * @param {string} archivePath - Destination path for the downloaded archive
 */
function downloadArchive(archivePath) {
  console.log("Downloading Whisper ONNX model...");
  execSync(`curl -L -o "${archivePath}" "${MODEL_URL}"`, { stdio: "inherit" });
}

/**
 * Extract the tar.bz2 archive into the model directory.
 *
 * @param {string} archivePath - Path to the archive file
 */
function extractArchive(archivePath) {
  console.log("Extracting model archive...");
  execSync(`tar xjf "${archivePath}" -C "${MODEL_DIR}"`, { stdio: "inherit" });
}

/**
 * Move the 3 required model files from the extracted directory to the model directory.
 *
 * @param {string} extractedPath - Path to the extracted archive directory
 */
function moveModelFiles(extractedPath) {
  for (const file of REQUIRED_FILES) {
    const src = join(extractedPath, file);
    const dest = join(MODEL_DIR, file);

    if (!existsSync(src)) {
      throw new Error(`Expected model file not found in archive: ${file}`);
    }

    renameSync(src, dest);
  }
  console.log("Model files installed successfully.");
}

/**
 * Remove the downloaded archive and extracted directory.
 *
 * @param {string} archivePath - Path to the archive file
 * @param {string} extractedPath - Path to the extracted directory
 */
function cleanup(archivePath, extractedPath) {
  if (existsSync(archivePath)) {
    rmSync(archivePath);
  }
  if (existsSync(extractedPath)) {
    rmSync(extractedPath, { recursive: true });
  }
}
