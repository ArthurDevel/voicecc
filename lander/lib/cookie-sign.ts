/**
 * HMAC cookie signing and verification.
 *
 * Signs cookie values with a secret to prevent forgery. Uses HMAC-SHA256.
 * Format: "<base64-payload>.<base64-signature>"
 *
 * - Sign user data before setting cookies
 * - Verify signature before trusting cookie contents
 */

import { createHmac } from "crypto";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Signs a value with HMAC-SHA256 using the COOKIE_SECRET env var.
 * @param value - The string to sign (typically JSON)
 * @returns Signed string in format "base64payload.base64signature"
 */
export function signValue(value: string): string {
  const secret = requireSecret();
  const payload = Buffer.from(value).toString("base64");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64");
  return `${payload}.${signature}`;
}

/**
 * Verifies and extracts the original value from a signed cookie.
 * @param signed - The signed string from the cookie
 * @returns The original value, or null if the signature is invalid
 */
export function verifyValue(signed: string): string | null {
  const secret = requireSecret();
  const dotIndex = signed.indexOf(".");
  if (dotIndex === -1) return null;

  const payload = signed.substring(0, dotIndex);
  const signature = signed.substring(dotIndex + 1);

  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64");

  if (signature !== expected) return null;

  return Buffer.from(payload, "base64").toString();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Reads COOKIE_SECRET from env vars.
 * @returns The secret string
 */
function requireSecret(): string {
  const secret = process.env.COOKIE_SECRET;
  if (!secret) throw new Error("COOKIE_SECRET environment variable is not set");
  return secret;
}
