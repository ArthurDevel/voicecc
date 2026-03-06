/**
 * Tests for the audio inactivity watchdog.
 *
 * Verifies that the watchdog fires a callback when audio frames stop arriving,
 * and that ongoing audio keeps the connection alive.
 *
 * Run: npx tsx --test sidecar/audio-inactivity.test.ts
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { createAudioInactivityWatchdog } from "./audio-inactivity.js";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Wait for a given number of milliseconds.
 *
 * @param ms - Duration to wait
 * @returns Resolves after the delay
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// TESTS
// ============================================================================

/**
 * When no audio arrives within the timeout window, the onTimeout callback
 * must fire. This is the core scenario: caller hangs up, audio stops.
 */
test("fires callback when no audio arrives within timeout", async () => {
  let fired = false;

  const watchdog = createAudioInactivityWatchdog({
    timeoutMs: 100,
    checkIntervalMs: 30,
    onTimeout: () => { fired = true; },
  });

  try {
    await sleep(200);
    assert.ok(fired, "onTimeout should have fired after 100ms of silence");
  } finally {
    watchdog.dispose();
  }
});

/**
 * When audio frames keep arriving (via ping()), the callback must not fire.
 * This simulates a healthy active call.
 */
test("does not fire callback while audio keeps arriving", async () => {
  let fired = false;

  const watchdog = createAudioInactivityWatchdog({
    timeoutMs: 100,
    checkIntervalMs: 30,
    onTimeout: () => { fired = true; },
  });

  try {
    // Send pings for 250ms (well past the 100ms timeout)
    for (let i = 0; i < 8; i++) {
      watchdog.ping();
      await sleep(30);
    }

    assert.ok(!fired, "onTimeout should not fire while audio is arriving");
  } finally {
    watchdog.dispose();
  }
});

/**
 * When audio stops after a period of activity, the callback fires.
 * Simulates: call is active for a while, then caller hangs up.
 */
test("fires callback when audio stops after period of activity", async () => {
  let fired = false;

  const watchdog = createAudioInactivityWatchdog({
    timeoutMs: 100,
    checkIntervalMs: 30,
    onTimeout: () => { fired = true; },
  });

  try {
    // Active call: send pings for 150ms
    for (let i = 0; i < 5; i++) {
      watchdog.ping();
      await sleep(30);
    }

    assert.ok(!fired, "should not have fired during active audio");

    // Caller hangs up: no more pings
    await sleep(200);
    assert.ok(fired, "onTimeout should fire after audio stops");
  } finally {
    watchdog.dispose();
  }
});
