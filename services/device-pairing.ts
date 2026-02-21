/**
 * Device pairing and token management for WebRTC browser calling.
 *
 * Handles the pairing flow between the dashboard and remote devices:
 * - Generate 6-digit pairing codes with 5-minute TTL
 * - Validate codes and issue persistent device tokens
 * - Persist device tokens to disk across restarts
 * - Purge expired pairing codes automatically
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

// ============================================================================
// TYPES
// ============================================================================

/** Internal pairing code entry */
interface PairingCode {
  expiresAt: number;
  attempts: number;
}

/** Stored device token info */
interface DeviceTokenInfo {
  pairedAt: number;
  userAgent: string;
}

/** Result of generating a new pairing code */
export interface PairingResult {
  code: string;
  expiresAt: number;
}

/** Result of validating a pairing code */
export interface PairingValidation {
  ok: boolean;
  token?: string;
  error?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;
const DEVICE_TOKENS_PATH = join(process.cwd(), ".device-tokens.json");

// ============================================================================
// STATE
// ============================================================================

/** Active pairing codes: code -> { expiresAt, attempts } */
const pairingCodes = new Map<string, PairingCode>();

/** Paired device tokens: token -> { pairedAt, userAgent } */
const deviceTokens = new Map<string, DeviceTokenInfo>();

// Purge expired pairing codes every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, data] of pairingCodes) {
    if (now > data.expiresAt) pairingCodes.delete(code);
  }
}, 60_000);

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Generate a 6-digit pairing code with a 5-minute TTL.
 *
 * @returns The generated code and its expiration timestamp
 */
export function generatePairingCode(): PairingResult {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
  pairingCodes.set(code, { expiresAt, attempts: 0 });
  return { code, expiresAt };
}

/**
 * Validate a pairing code and issue a device token on success.
 * Enforces max attempts and single-use consumption.
 *
 * @param code - The 6-digit pairing code to validate
 * @param userAgent - The device's user-agent string
 * @returns Validation result with token on success or error on failure
 */
export function validateAndConsumeCode(code: string, userAgent: string): PairingValidation {
  const entry = pairingCodes.get(code);

  if (!entry) {
    return { ok: false, error: "Invalid pairing code" };
  }

  if (Date.now() > entry.expiresAt) {
    pairingCodes.delete(code);
    return { ok: false, error: "Pairing code expired" };
  }

  entry.attempts++;
  if (entry.attempts > PAIRING_MAX_ATTEMPTS) {
    pairingCodes.delete(code);
    return { ok: false, error: "Too many attempts, code invalidated" };
  }

  // Code is valid -- delete it (single-use) and issue a device token
  pairingCodes.delete(code);
  const token = randomUUID();
  deviceTokens.set(token, { pairedAt: Date.now(), userAgent });
  saveDeviceTokens().catch(() => {});

  return { ok: true, token };
}

/**
 * Check if a device token exists in the store.
 *
 * @param token - The device token to validate
 * @returns True if the token is valid
 */
/**
 * Check if a pairing code is still active (not yet consumed or expired).
 *
 * @param code - The 6-digit pairing code
 * @returns True if the code is still waiting to be used
 */
export function isPairingCodeActive(code: string): boolean {
  const entry = pairingCodes.get(code);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pairingCodes.delete(code);
    return false;
  }
  return true;
}

export function isValidDeviceToken(token: string): boolean {
  return deviceTokens.has(token);
}

/**
 * Load persisted device tokens from disk on startup.
 * Call this before mounting routes.
 */
export async function loadDeviceTokens(): Promise<void> {
  try {
    const data = JSON.parse(await readFile(DEVICE_TOKENS_PATH, "utf-8"));
    for (const [token, info] of Object.entries(data)) {
      deviceTokens.set(token, info as DeviceTokenInfo);
    }
  } catch {
    // File doesn't exist or is invalid -- start fresh
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Persist device tokens to disk.
 * Called internally by validateAndConsumeCode on success.
 */
async function saveDeviceTokens(): Promise<void> {
  const data: Record<string, DeviceTokenInfo> = {};
  for (const [token, info] of deviceTokens) {
    data[token] = info;
  }
  await writeFile(DEVICE_TOKENS_PATH, JSON.stringify(data), "utf-8");
}
