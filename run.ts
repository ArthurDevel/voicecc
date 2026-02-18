/**
 * Top-level entry point that boots the dashboard server.
 *
 * Responsibilities:
 * - Start the dashboard HTTP server (editor UI, conversation viewer, voice launcher)
 */

import { startDashboard } from "./dashboard/server.js";

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

async function main(): Promise<void> {
  await startDashboard();
  console.log("Dashboard ready. Use the 'Start Voice' button to begin a voice session.");
}

// ============================================================================
// ENTRY POINT
// ============================================================================

main().catch((err) => {
  console.error(`Startup failed: ${err}`);
  process.exit(1);
});
