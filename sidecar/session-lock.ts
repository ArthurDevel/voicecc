/**
 * Cross-process session limiter using PID-based lock files.
 *
 * Ensures the total number of active voice sessions (local mic + Twilio combined)
 * does not exceed MAX_CONCURRENT_SESSIONS. Stale lock files from crashed processes
 * are automatically cleaned up on every acquire.
 *
 * Responsibilities:
 * - Acquire a session slot by creating a PID lock file in ~/.claude-voice-sessions/
 * - Validate existing lock files by checking if their PIDs are still alive
 * - Clean up stale lock files from dead processes
 * - Release the lock file on session stop or process exit
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Directory where PID lock files are stored */
const LOCK_DIR = join(homedir(), ".claude-voice-sessions");

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Handle returned by acquireSessionLock. Call release() to free the session slot.
 */
export interface SessionLock {
  /** Release the session lock (deletes the lock file) */
  release: () => void;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Acquire a session lock slot. Throws if the maximum number of concurrent
 * sessions has been reached.
 *
 * Cleans up stale lock files (dead PIDs) on every call. Creates a new lock
 * file containing the current PID. Registers a process.on('exit') handler
 * as a safety net to release on shutdown.
 *
 * @param maxSessions - Maximum number of concurrent sessions allowed
 * @returns A SessionLock handle with a release() method
 * @throws Error if maxSessions has been reached
 */
export function acquireSessionLock(maxSessions: number): SessionLock {
  // Ensure lock directory exists
  mkdirSync(LOCK_DIR, { recursive: true });

  // List existing lock files and validate their PIDs
  const files = readdirSync(LOCK_DIR).filter((f) => f.endsWith(".lock"));
  let activeCount = 0;

  for (const file of files) {
    const filePath = join(LOCK_DIR, file);
    try {
      const pid = parseInt(readFileSync(filePath, "utf-8").trim(), 10);
      if (isNaN(pid) || !isProcessAlive(pid)) {
        // Stale lock file -- process is dead, clean it up
        unlinkSync(filePath);
      } else {
        activeCount++;
      }
    } catch {
      // File disappeared between readdir and read, or parse error -- skip
      try { unlinkSync(filePath); } catch { /* already gone */ }
    }
  }

  if (activeCount >= maxSessions) {
    throw new Error(
      `Session limit reached (${activeCount}/${maxSessions}). ` +
      `Cannot start another voice session.`
    );
  }

  // Create a new lock file with the current PID
  const lockFile = join(LOCK_DIR, `${randomUUID()}.lock`);
  writeFileSync(lockFile, String(process.pid), "utf-8");

  let released = false;

  /** Delete the lock file if it hasn't been released yet */
  function release(): void {
    if (released) return;
    released = true;
    try { unlinkSync(lockFile); } catch { /* already gone */ }
  }

  // Safety net: release on process exit
  process.on("exit", release);

  return { release };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a process with the given PID is still alive.
 * Uses signal 0 which does not kill the process -- it only checks existence.
 *
 * @param pid - The process ID to check
 * @returns true if the process is alive, false otherwise
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
