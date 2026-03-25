/**
 * Provider status API routes.
 *
 * Exposes provider validation endpoints for the dashboard:
 * - GET /elevenlabs/validate -- validate the stored ElevenLabs API key
 *
 * TTS/STT provider selection has been removed -- Pipecat handles
 * provider configuration in the Python voice server.
 */

import { Hono } from "hono";

import { readEnv } from "../../server/services/env.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for provider status operations.
 *
 * @returns Hono instance with provider validation routes
 */
export function providersRoutes(): Hono {
  const app = new Hono();

  /** Check whether an ElevenLabs API key is configured in .env */
  app.get("/elevenlabs/validate", async (c) => {
    const env = await readEnv();
    const apiKey = env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return c.json({ status: "missing" as const });
    }

    return c.json({ status: "valid" as const });
  });

  /** Build ElevenLabs provider info from current .env state */
  async function elevenLabsProvider() {
    const env = await readEnv();
    const hasKey = !!env.ELEVENLABS_API_KEY;
    return {
      type: "elevenlabs",
      name: "ElevenLabs",
      description: "High-quality neural text-to-speech and speech-to-text",
      status: hasKey
        ? { ready: true }
        : { ready: false, reason: "missing_api_key" as const },
    };
  }

  /** List TTS providers with status */
  app.get("/tts", async (c) => {
    const provider = await elevenLabsProvider();
    return c.json({ providers: [provider], active: "elevenlabs" });
  });

  /** List STT providers with status */
  app.get("/stt", async (c) => {
    const provider = await elevenLabsProvider();
    return c.json({ providers: [provider], active: "elevenlabs" });
  });

  return app;
}
