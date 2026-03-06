/**
 * Audio inactivity watchdog for streaming connections.
 *
 * Detects when a caller hangs up but the WebSocket doesn't close cleanly.
 * Twilio sends audio frames continuously during an active call (even silence).
 * When frames stop arriving, the call is dead and the onTimeout callback fires
 * so the caller can tear down the session.
 *
 * Responsibilities:
 * - Track timestamps of incoming audio frames via ping()
 * - Periodically check whether audio has gone silent beyond a threshold
 * - Fire a callback when the timeout is exceeded
 * - Clean up the interval timer on dispose
 */

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default: close the connection if no audio frames arrive within this window (ms) */
const DEFAULT_TIMEOUT_MS = 5000;

/** Default: how often to check for audio inactivity (ms) */
const DEFAULT_CHECK_INTERVAL_MS = 2000;

// ============================================================================
// INTERFACES
// ============================================================================

/** Configuration for the audio inactivity watchdog */
export interface AudioInactivityConfig {
  /** Time without audio before firing the callback (ms). Default: 5000 */
  timeoutMs?: number;
  /** How often to check for inactivity (ms). Default: 2000 */
  checkIntervalMs?: number;
  /** Called when the timeout is exceeded */
  onTimeout: () => void;
}

/** Handle returned by createAudioInactivityWatchdog */
export interface AudioInactivityWatchdog {
  /** Call this when an audio frame arrives to reset the timer */
  ping: () => void;
  /** Stop the watchdog and clean up the interval */
  dispose: () => void;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create an audio inactivity watchdog that fires a callback when no audio
 * frames have arrived within the configured timeout.
 *
 * @param config - Timeout thresholds and callback
 * @returns A watchdog handle with ping() and dispose() methods
 */
export function createAudioInactivityWatchdog(config: AudioInactivityConfig): AudioInactivityWatchdog {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkIntervalMs = config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  let lastAudioAt = Date.now();
  let fired = false;

  const timer = setInterval(() => {
    if (fired) return;

    const silentMs = Date.now() - lastAudioAt;
    if (silentMs >= timeoutMs) {
      fired = true;
      config.onTimeout();
    }
  }, checkIntervalMs);

  /**
   * Signal that an audio frame was received. Resets the inactivity clock.
   */
  function ping(): void {
    lastAudioAt = Date.now();
  }

  /**
   * Stop the watchdog and clean up resources.
   */
  function dispose(): void {
    clearInterval(timer);
  }

  return { ping, dispose };
}
