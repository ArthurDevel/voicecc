/**
 * Twilio audio adapter for WebSocket-based media streams.
 *
 * Implements the AudioAdapter interface for Twilio phone calls by converting
 * between Twilio's mulaw 8kHz format and the pipeline's float32 16kHz (input)
 * and int16 24kHz (output) formats.
 *
 * Responsibilities:
 * - Encode/decode G.711 mu-law audio (ITU-T standard)
 * - Resample between 8kHz, 16kHz, and 24kHz (integer-ratio conversions)
 * - Convert Twilio base64 media payloads to Float32Array for VAD/STT
 * - Convert 24kHz PCM from TTS to Twilio base64 media payloads
 * - Manage WebSocket message I/O with close-state tracking
 * - Cache the ready chime as 24kHz PCM for playback over the call
 */

import type { WebSocket } from "ws";
import type { AudioAdapter } from "./audio-adapter.js";

import { decodeChimeToPcm } from "./chime.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Bias constant for G.711 mu-law encoding */
const MULAW_BIAS = 0x84;

/** Maximum value for G.711 mu-law encoding (clamped to avoid overflow) */
const MULAW_CLIP = 32635;

// ============================================================================
// TYPES
// ============================================================================

/** Configuration for creating a Twilio audio adapter */
export interface TwilioAudioAdapterConfig {
  /** Active Twilio WebSocket connection for the media stream */
  ws: WebSocket;
  /** Twilio stream identifier for outgoing messages */
  streamSid: string;
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Create an AudioAdapter that reads/writes audio over a Twilio WebSocket media stream.
 *
 * Decodes the macOS Glass.aiff chime to raw 24kHz PCM during initialization
 * and caches the buffer for playChime(). Tracks WebSocket open/closed state
 * so that writes to a closed socket are silently ignored.
 *
 * @param config - Twilio WebSocket and stream identifier
 * @returns An AudioAdapter for Twilio phone call I/O
 */
export function createTwilioAudioAdapter(config: TwilioAudioAdapterConfig): AudioAdapter {
  const { ws, streamSid } = config;

  let wsClosed = false;
  let audioCallback: ((samples: Float32Array) => void) | null = null;

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
   * Subscribe to incoming audio chunks from the Twilio media stream.
   * Registers a WebSocket message handler that decodes media events and
   * invokes the callback with Float32Array samples (16kHz, normalized).
   *
   * @param callback - Called with each audio chunk as Float32Array
   */
  function onAudio(callback: (samples: Float32Array) => void): void {
    audioCallback = callback;

    ws.on("message", (data: Buffer | string) => {
      if (wsClosed) return;

      const msg = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
      if (msg.event !== "media") return;

      const samples = twilioPayloadToFloat32(msg.media.payload);
      audioCallback?.(samples);
    });
  }

  /**
   * Write PCM audio to the Twilio media stream.
   * Converts 24kHz int16 PCM to base64 mulaw 8kHz and sends it over WebSocket.
   * Silently returns if the WebSocket has closed (session is tearing down).
   *
   * @param pcm - Raw PCM buffer (16-bit signed, 24kHz mono)
   * @returns Resolves immediately (no backpressure at telephony bitrates)
   */
  async function writeSpeaker(pcm: Buffer): Promise<void> {
    if (wsClosed) return;

    const payload = pcm24kToTwilioPayload(pcm);
    const message = JSON.stringify({
      event: "media",
      streamSid,
      media: { payload },
    });

    ws.send(message);
  }

  /**
   * Clear Twilio's audio playback buffer immediately (user interruption).
   * Sends a "clear" event over the WebSocket.
   */
  function interrupt(): void {
    if (wsClosed) return;

    ws.send(JSON.stringify({ event: "clear", streamSid }));
  }

  /**
   * Resume output after an interrupt. No-op for Twilio -- it accepts
   * new audio immediately after a clear event.
   */
  function resume(): void {
    // No-op: Twilio accepts audio immediately after clear
  }

  /**
   * Play the ready chime by sending the cached 24kHz PCM through writeSpeaker.
   */
  function playChime(): void {
    writeSpeaker(chimePcm);
  }

  /**
   * Clean up resources. No-op for Twilio -- WebSocket lifecycle is
   * managed by twilio-server.ts.
   */
  function destroy(): void {
    // No-op: WebSocket lifecycle managed by twilio-server.ts
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

// ============================================================================
// CODEC FUNCTIONS
// ============================================================================

/**
 * Decode a single mu-law byte to a 16-bit linear PCM sample.
 * Implements the G.711 ITU-T standard mu-law decompression.
 *
 * @param byte - Mu-law encoded byte (0-255)
 * @returns 16-bit signed PCM sample (-32768 to 32767)
 */
export function mulawDecode(byte: number): number {
  // Complement the byte (mu-law stores inverted)
  byte = ~byte & 0xff;

  // Extract sign bit (bit 7)
  const sign = byte & 0x80;

  // Extract exponent (bits 6-4) and mantissa (bits 3-0)
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;

  // Reconstruct the magnitude: add mantissa with implicit bit, shift by exponent, subtract bias
  let sample = ((mantissa << 1) + 33) << exponent;
  sample -= 33;

  return sign ? -sample : sample;
}

/**
 * Encode a single 16-bit linear PCM sample to a mu-law byte.
 * Implements the G.711 ITU-T standard mu-law compression.
 *
 * @param sample - 16-bit signed PCM sample (-32768 to 32767)
 * @returns Mu-law encoded byte (0-255)
 */
export function mulawEncode(sample: number): number {
  // Determine sign and work with magnitude
  let sign = 0;
  if (sample < 0) {
    sign = 0x80;
    sample = -sample;
  }

  // Add bias and clamp to prevent overflow
  sample += MULAW_BIAS;
  if (sample > MULAW_CLIP) {
    sample = MULAW_CLIP;
  }

  // Find the segment (exponent) by counting leading magnitude bits
  let exponent = 7;
  let mask = 0x4000;
  while (exponent > 0 && (sample & mask) === 0) {
    exponent--;
    mask >>= 1;
  }

  // Extract the 4-bit mantissa from the appropriate position
  const mantissa = (sample >> (exponent + 3)) & 0x0f;

  // Combine sign, exponent, mantissa and complement
  const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mulaw;
}

// ============================================================================
// RESAMPLING FUNCTIONS
// ============================================================================

/**
 * Upsample audio from 8kHz to 16kHz using linear interpolation (2x).
 * For N input samples, outputs 2N samples. Each pair consists of the
 * original sample and the average of it and the next sample.
 *
 * @param input - Int16 PCM samples at 8kHz
 * @returns Int16 PCM samples at 16kHz (2x length)
 */
function upsample8to16(input: Int16Array): Int16Array {
  const output = new Int16Array(input.length * 2);

  for (let i = 0; i < input.length - 1; i++) {
    output[2 * i] = input[i];
    output[2 * i + 1] = ((input[i] + input[i + 1]) >> 1) as number;
  }

  // Last sample: duplicate (no next sample to interpolate with)
  const last = input.length - 1;
  output[2 * last] = input[last];
  output[2 * last + 1] = input[last];

  return output;
}

/**
 * Downsample audio from 24kHz to 8kHz by averaging groups of 3 samples (3x).
 * Acts as a simple low-pass filter before decimation. Adequate for telephony
 * output which has no useful content above 4kHz.
 *
 * @param input - Int16 PCM samples at 24kHz
 * @returns Int16 PCM samples at 8kHz (1/3 length)
 */
function downsample24to8(input: Int16Array): Int16Array {
  const outputLen = Math.floor(input.length / 3);
  const output = new Int16Array(outputLen);

  for (let i = 0; i < outputLen; i++) {
    const offset = i * 3;
    output[i] = Math.round((input[offset] + input[offset + 1] + input[offset + 2]) / 3);
  }

  return output;
}

// ============================================================================
// PAYLOAD CONVERSION FUNCTIONS
// ============================================================================

/**
 * Convert a Twilio media payload to Float32Array at 16kHz for VAD/STT.
 *
 * Pipeline: base64 decode -> mulaw to PCM int16 -> upsample 2x (8kHz to 16kHz)
 * -> normalize to float32 (-1.0 to 1.0).
 *
 * @param base64Payload - Base64-encoded mulaw audio at 8kHz from Twilio
 * @returns Float32Array of normalized samples at 16kHz
 */
export function twilioPayloadToFloat32(base64Payload: string): Float32Array {
  // Base64 decode to raw mulaw bytes
  const mulawBytes = Buffer.from(base64Payload, "base64");

  // Decode mulaw to int16 PCM at 8kHz
  const pcm8k = new Int16Array(mulawBytes.length);
  for (let i = 0; i < mulawBytes.length; i++) {
    pcm8k[i] = mulawDecode(mulawBytes[i]);
  }

  // Upsample from 8kHz to 16kHz
  const pcm16k = upsample8to16(pcm8k);

  // Normalize int16 to float32 (-1.0 to 1.0)
  const float32 = new Float32Array(pcm16k.length);
  for (let i = 0; i < pcm16k.length; i++) {
    float32[i] = pcm16k[i] / 32768;
  }

  return float32;
}

/**
 * Convert TTS PCM output to a Twilio media payload.
 *
 * Pipeline: read int16 samples from buffer -> downsample 3x (24kHz to 8kHz)
 * -> mulaw encode -> base64.
 *
 * @param pcmBuffer - Raw PCM buffer (16-bit signed, 24kHz mono) from TTS
 * @returns Base64-encoded mulaw audio at 8kHz for Twilio
 */
export function pcm24kToTwilioPayload(pcmBuffer: Buffer): string {
  // Read int16 samples from the PCM buffer
  const sampleCount = pcmBuffer.length / 2;
  const pcm24k = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    pcm24k[i] = pcmBuffer.readInt16LE(i * 2);
  }

  // Downsample from 24kHz to 8kHz
  const pcm8k = downsample24to8(pcm24k);

  // Encode each sample to mulaw
  const mulawBytes = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulawBytes[i] = mulawEncode(pcm8k[i]);
  }

  // Base64 encode
  return mulawBytes.toString("base64");
}
