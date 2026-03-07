/**
 * Browser call server state management.
 *
 * Tracks whether the browser call integration is enabled/active.
 * The actual WebSocket handling runs in the unified voice server
 * (voice-server.ts) — this module just manages the enabled state
 * for the dashboard UI.
 */

// ============================================================================
// TYPES
// ============================================================================

/** Browser call server status for the dashboard UI */
export interface BrowserCallStatus {
  /** Whether the browser call integration is active */
  running: boolean;
}

// ============================================================================
// STATE
// ============================================================================

/** Whether the browser call integration is active */
let browserRunning = false;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Mark the browser call integration as started.
 * The voice server is already running and accepts /audio WebSocket connections.
 *
 * @param _dashboardPort - Unused (kept for API compatibility)
 */
export async function startBrowserCallServer(_dashboardPort: number): Promise<void> {
  if (browserRunning) {
    throw new Error("Browser call server is already running");
  }

  browserRunning = true;
  console.log("Browser call integration started.");
}

/**
 * Mark the browser call integration as stopped.
 */
export function stopBrowserCallServer(): void {
  browserRunning = false;
}

/**
 * Get the status of the browser call integration.
 *
 * @returns Status with running state
 */
export function getBrowserCallStatus(): BrowserCallStatus {
  return { running: browserRunning };
}

/**
 * Check whether the browser call integration is active.
 *
 * @returns True if the integration is active
 */
export function isBrowserCallRunning(): boolean {
  return browserRunning;
}
