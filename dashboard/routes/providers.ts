/**
 * Provider status API routes.
 *
 * Exposes provider listing and validation endpoints for the dashboard:
 * - GET /tts -- list TTS providers with status and active selection
 * - GET /stt -- list STT providers with status and active selection
 * - GET /elevenlabs/validate -- validate the stored ElevenLabs API key
 * - GET /deepgram/validate -- validate the stored Deepgram API key
 * - GET /tts/elevenlabs/voices -- list available ElevenLabs voices
 * - GET /tts/deepgram/voices -- list available Deepgram Aura voices
 */

import { Hono } from "hono";

import { readEnv } from "../../server/services/env.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PROVIDER = "elevenlabs";

/** Hardcoded Deepgram Aura voice list (Deepgram has no voice listing API) */
const DEEPGRAM_VOICES = [
  { id: "aura-asteria-en", name: "Asteria (Female)" },
  { id: "aura-luna-en", name: "Luna (Female)" },
  { id: "aura-stella-en", name: "Stella (Female)" },
  { id: "aura-athena-en", name: "Athena (Female)" },
  { id: "aura-hera-en", name: "Hera (Female)" },
  { id: "aura-orion-en", name: "Orion (Male)" },
  { id: "aura-arcas-en", name: "Arcas (Male)" },
  { id: "aura-perseus-en", name: "Perseus (Male)" },
  { id: "aura-angus-en", name: "Angus (Male)" },
  { id: "aura-orpheus-en", name: "Orpheus (Male)" },
  { id: "aura-helios-en", name: "Helios (Male)" },
  { id: "aura-zeus-en", name: "Zeus (Male)" },
];

// ============================================================================
// TYPES
// ============================================================================

/** Provider readiness status */
interface ProviderStatus {
  ready: boolean;
  reason?: "missing_api_key";
}

/** Provider info returned by listing endpoints */
export interface ProviderInfo {
  type: string;
  name: string;
  description: string;
  status: ProviderStatus;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Build ElevenLabs provider info from current .env state.
 *
 * @param env - parsed .env key-value record
 * @returns provider info with readiness based on API key presence
 */
function elevenLabsProvider(env: Record<string, string>): ProviderInfo {
  const hasKey = !!env.ELEVENLABS_API_KEY;
  return {
    type: "elevenlabs",
    name: "ElevenLabs",
    description: "High-quality neural text-to-speech and speech-to-text",
    status: hasKey
      ? { ready: true }
      : { ready: false, reason: "missing_api_key" },
  };
}

/**
 * Build Deepgram provider info from current .env state.
 *
 * @param env - parsed .env key-value record
 * @returns provider info with readiness based on API key presence
 */
function deepgramProvider(env: Record<string, string>): ProviderInfo {
  const hasKey = !!env.DEEPGRAM_API_KEY;
  return {
    type: "deepgram",
    name: "Deepgram",
    description: "Fast, accurate speech-to-text and text-to-speech",
    status: hasKey
      ? { ready: true }
      : { ready: false, reason: "missing_api_key" },
  };
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for provider status operations.
 *
 * @returns Hono instance with provider listing and validation routes
 */
export function providersRoutes(): Hono {
  const app = new Hono();

  // -- Validation endpoints --------------------------------------------------

  /** Check whether an ElevenLabs API key is configured in .env */
  app.get("/elevenlabs/validate", async (c) => {
    const env = await readEnv();
    const status = env.ELEVENLABS_API_KEY ? "valid" : "missing";
    return c.json({ status });
  });

  /** Check whether a Deepgram API key is configured in .env */
  app.get("/deepgram/validate", async (c) => {
    const env = await readEnv();
    const status = env.DEEPGRAM_API_KEY ? "valid" : "missing";
    return c.json({ status });
  });

  // -- Provider listing endpoints --------------------------------------------

  /** List TTS providers with status and active selection */
  app.get("/tts", async (c) => {
    const env = await readEnv();
    const active = env.TTS_PROVIDER || DEFAULT_PROVIDER;
    return c.json({
      providers: [elevenLabsProvider(env), deepgramProvider(env)],
      active,
    });
  });

  /** List STT providers with status and active selection */
  app.get("/stt", async (c) => {
    const env = await readEnv();
    const active = env.STT_PROVIDER || DEFAULT_PROVIDER;
    return c.json({
      providers: [elevenLabsProvider(env), deepgramProvider(env)],
      active,
    });
  });

  // -- Voice listing endpoints -----------------------------------------------

  /** List available ElevenLabs voices (calls ElevenLabs REST API) */
  app.get("/tts/elevenlabs/voices", async (c) => {
    const env = await readEnv();
    const apiKey = env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return c.json({ voices: [] });
    }

    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });

    if (!res.ok) {
      return c.json({ voices: [] });
    }

    const data = (await res.json()) as { voices: Array<{ voice_id: string; name: string }> };
    const voices = data.voices.map((v) => ({ id: v.voice_id, name: v.name }));
    return c.json({ voices });
  });

  /** List available Deepgram Aura voices (hardcoded) */
  app.get("/tts/deepgram/voices", async (c) => {
    return c.json({ voices: DEEPGRAM_VOICES });
  });

  return app;
}
