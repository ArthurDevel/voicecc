/**
 * Browser call status helper.
 *
 * Browser calling is always enabled. This module provides the call base URL
 * which uses the tunnel when available, otherwise falls back to localhost.
 */

import { getTunnelUrl } from "./tunnel.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Voice server port (matches voice-server.ts default) */
const VOICE_PORT = parseInt(process.env.TWILIO_PORT ?? "", 10) || 8080;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Get the base URL for the browser call page.
 * Uses tunnel URL when available, otherwise falls back to localhost.
 *
 * @returns The base URL for the call page
 */
export function getCallBaseUrl(): string {
  return getTunnelUrl() ?? `http://localhost:${VOICE_PORT}`;
}
