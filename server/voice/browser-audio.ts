/**
 * Browser audio adapter for direct WebSocket connections.
 *
 * Implements the AudioAdapter interface for browser-based voice calls by
 * exchanging raw PCM audio over a WebSocket. Simpler than TwilioAudioAdapter --
 * no mulaw codec, no Twilio-specific protocol framing.
 *
 * Responsibilities:
 * - Receive Float32Array PCM at 16kHz from the browser via binary WebSocket messages
 * - Send int16 24kHz PCM as binary WebSocket messages to the browser
 * - Handle backpressure on writeSpeaker via ws.send callback
 * - Send JSON control messages (e.g. "clear" for interruption)
 * - Cache the ready chime as 24kHz PCM for playback
 */

import type { WebSocket } from "ws";
import type { AudioAdapter } from "./audio-adapter.js";

import { decodeChimeToPcm } from "./chime.js";

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for creating a browser audio adapter */
export interface BrowserAudioAdapterConfig {
  /** Active WebSocket connection to the browser */
  ws: WebSocket;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create an AudioAdapter that reads/writes audio over a browser WebSocket connection.
 *
 * Decodes the macOS Glass.aiff chime to raw 24kHz PCM during initialization
 * and caches the buffer for playChime(). The browser sends Float32Array PCM at
 * 16kHz as binary messages, and receives int16 24kHz PCM as binary messages.
 *
 * @param config - Browser WebSocket connection
 * @returns An AudioAdapter for browser audio I/O
 */
export function createBrowserAudioAdapter(config: BrowserAudioAdapterConfig): AudioAdapter {
  const { ws } = config;

  let wsClosed = false;

  // Track WebSocket close state
  ws.on("close", () => {
    wsClosed = true;
  });

  // Decode chime to raw 24kHz PCM and cache it
  const chimePcm = decodeChimeToPcm();

  // --------------------------------------------------------------------------
  // AudioAdapter methods
  // --------------------------------------------------------------------------

  /**
   * Subscribe to incoming audio chunks from the browser.
   * Registers a WebSocket binary message handler that converts the incoming
   * Buffer to Float32Array and invokes the callback. Ignores text (JSON) messages.
   *
   * @param callback - Called with each audio chunk as Float32Array (16kHz)
   */
  function onAudio(callback: (samples: Float32Array) => void): void {
    ws.on("message", (data: Buffer | string, isBinary: boolean) => {
      if (wsClosed) return;

      // Only process binary messages (audio data)
      if (!isBinary) return;

      // Convert Buffer to Float32Array (copy to ensure 4-byte alignment)
      const buffer = data as Buffer;
      const aligned = new ArrayBuffer(buffer.byteLength);
      new Uint8Array(aligned).set(buffer);
      const float32 = new Float32Array(aligned);
      callback(float32);
    });
  }

  /**
   * Write PCM audio to the browser via WebSocket.
   * Sends 24kHz int16 PCM buffer as a binary WebSocket message.
   * Uses ws.send callback for backpressure -- resolves when the data is flushed.
   * Silently returns if the WebSocket has closed.
   *
   * @param pcm - Raw PCM buffer (16-bit signed, 24kHz mono)
   * @returns Resolves when the write completes
   */
  function writeSpeaker(pcm: Buffer): Promise<void> {
    if (wsClosed) return Promise.resolve();

    return new Promise<void>((resolve) => {
      ws.send(pcm, { binary: true }, () => {
        // Resolve on both success and error -- write errors mean the
        // connection is closing, and callers should not need to handle that
        resolve();
      });
    });
  }

  /**
   * Clear the browser's playback buffer immediately (user interruption).
   * Sends a JSON "clear" message over the WebSocket.
   */
  function interrupt(): void {
    if (wsClosed) return;

    ws.send(JSON.stringify({ type: "clear" }));
  }

  /**
   * Resume output after an interrupt. No-op for browser --
   * AudioWorklet resumes consuming from ring buffer automatically after clear.
   */
  function resume(): void {
    // No-op: browser AudioWorklet resumes automatically
  }

  /**
   * Play the ready chime by sending the cached 24kHz PCM through writeSpeaker.
   */
  function playChime(): void {
    writeSpeaker(chimePcm);
  }

  /**
   * Clean up resources. No-op for browser -- WebSocket lifecycle is
   * managed by browser-server.ts.
   */
  function destroy(): void {
    // No-op: WebSocket lifecycle managed by browser-server.ts
  }

  return {
    onAudio,
    writeSpeaker,
    interrupt,
    resume,
    playChime,
    destroy,
  };
}
