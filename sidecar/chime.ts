/**
 * Shared utility for decoding the macOS ready chime to raw PCM.
 *
 * Extracted from twilio-audio.ts so the chime decoding logic is reused across
 * audio adapters (Twilio, browser) without duplication.
 *
 * Responsibilities:
 * - Decode macOS Glass.aiff to raw 24kHz int16 mono PCM via afconvert
 * - Use a PID-scoped temp file to avoid race conditions across processes
 */

import { execSync } from "child_process";
import { readFileSync, unlinkSync } from "fs";

// ============================================================================
// CONSTANTS
// ============================================================================

/** macOS system sound used for the ready chime */
export const READY_CHIME_PATH = "/System/Library/Sounds/Glass.aiff";

/** Temp file path for afconvert output, scoped by PID to avoid collisions */
export const CHIME_TEMP_PATH = `/tmp/chime-24k-${process.pid}.raw`;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/** CAF data chunk: 'data' (4B) + size (8B) + editCount (4B) = 16 bytes before PCM */
const CAF_DATA_CHUNK_HEADER_SIZE = 16;

/**
 * Decode the macOS Glass.aiff system sound to raw 24kHz int16 PCM.
 * Uses afconvert (macOS built-in) to convert to CAF format, then strips
 * the CAF container header to extract the raw PCM payload.
 *
 * @returns Buffer containing raw 24kHz int16 mono PCM
 * @throws Error if afconvert fails, temp file cannot be read, or CAF has no data chunk
 */
export function decodeChimeToPcm(): Buffer {
  execSync(`afconvert -f caff -d LEI16@24000 -c 1 ${READY_CHIME_PATH} ${CHIME_TEMP_PATH}`);

  const caf = readFileSync(CHIME_TEMP_PATH);

  unlinkSync(CHIME_TEMP_PATH);

  // Find the 'data' chunk marker and skip past its header to the raw PCM
  const dataMarker = caf.indexOf("data", 0, "ascii");
  if (dataMarker === -1) {
    throw new Error("CAF file missing 'data' chunk");
  }

  return caf.subarray(dataMarker + CAF_DATA_CHUNK_HEADER_SIZE);
}
