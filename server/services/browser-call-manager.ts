/**
 * Browser call status helper.
 *
 * Browser calling is always enabled. This module provides the call base URL
 * which uses the tunnel when available, otherwise falls back to localhost.
 */

import { getTunnelUrl } from "./tunnel.js";

// ============================================================================
// STATE
// ============================================================================

/** Dashboard port, set by server.ts after the dashboard starts listening. */
let dashboardPort = 3456;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Set the dashboard port for building call URLs.
 *
 * @param port - The dashboard server port
 */
export function setDashboardPort(port: number): void {
  dashboardPort = port;
}

/**
 * Get the base URL for the browser call page.
 * Uses tunnel URL when available, otherwise falls back to localhost.
 *
 * @returns The base URL for the call page
 */
export function getCallBaseUrl(): string {
  return getTunnelUrl() ?? `http://localhost:${dashboardPort}`;
}
