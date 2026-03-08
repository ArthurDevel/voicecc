/**
 * Shared utility for loading the ready chime as raw PCM.
 *
 * Reads a pre-converted raw 24kHz int16 mono PCM file bundled in init/.
 * Works on both macOS and Linux with no runtime dependencies.
 *
 * Responsibilities:
 * - Load the bundled chime-24k.raw file as a Buffer
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the bundled raw PCM chime (24kHz int16 mono) */
const CHIME_PATH = join(__dirname, "..", "..", "init", "chime-24k.raw");

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Load the bundled chime as raw 24kHz int16 mono PCM.
 *
 * @returns Buffer containing raw 24kHz int16 mono PCM
 * @throws Error if the chime file is missing
 */
export function decodeChimeToPcm(): Buffer {
  return readFileSync(CHIME_PATH);
}
