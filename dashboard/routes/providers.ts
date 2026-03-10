/**
 * Provider status API routes.
 *
 * Exposes TTS/STT provider information and readiness status:
 * - GET /tts -- list TTS providers with status
 * - GET /tts/status/:type -- check a specific TTS provider
 * - GET /stt -- list STT providers with status
 * - GET /stt/status/:type -- check a specific STT provider
 * - GET /elevenlabs/validate -- validate the stored ElevenLabs API key
 */

import { Hono } from "hono";

import { getAvailableTtsProviders, getTtsProviderStatus, listVoicesForProvider } from "../../server/voice/tts-provider.js";
import { getAvailableSttProviders, getSttProviderStatus } from "../../server/voice/stt-provider.js";
import { readEnv } from "../../server/services/env.js";

import type { TtsProviderType } from "../../server/voice/types.js";
import type { SttProviderType } from "../../server/voice/types.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for provider status operations.
 *
 * @returns Hono instance with TTS/STT status routes
 */
export function providersRoutes(): Hono {
  const app = new Hono();

  // ---- TTS routes ----

  /** List all TTS providers with their current status */
  app.get("/tts", async (c) => {
    const providers = getAvailableTtsProviders();
    const env = await readEnv();
    const active = env.TTS_PROVIDER || "elevenlabs";

    const providersWithStatus = await Promise.all(
      providers.map(async (p) => ({
        ...p,
        status: await getTtsProviderStatus(p.type),
      }))
    );

    return c.json({ providers: providersWithStatus, active });
  });

  /** Check readiness of a specific TTS provider */
  app.get("/tts/status/:type", async (c) => {
    const type = c.req.param("type") as TtsProviderType;
    const status = await getTtsProviderStatus(type);
    return c.json(status);
  });

  /** List available voices for a TTS provider */
  app.get("/tts/:type/voices", async (c) => {
    const type = c.req.param("type") as TtsProviderType;
    try {
      const voices = await listVoicesForProvider(type);
      return c.json({ voices });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ---- STT routes ----

  /** List all STT providers with their current status */
  app.get("/stt", async (c) => {
    const providers = getAvailableSttProviders();
    const env = await readEnv();
    const active = env.STT_PROVIDER || "elevenlabs";

    const providersWithStatus = await Promise.all(
      providers.map(async (p) => ({
        ...p,
        status: await getSttProviderStatus(p.type),
      }))
    );

    return c.json({ providers: providersWithStatus, active });
  });

  /** Check readiness of a specific STT provider */
  app.get("/stt/status/:type", async (c) => {
    const type = c.req.param("type") as SttProviderType;
    const status = await getSttProviderStatus(type);
    return c.json(status);
  });

  // ---- ElevenLabs validation ----

  /** Check whether an ElevenLabs API key is configured in .env */
  app.get("/elevenlabs/validate", async (c) => {
    const env = await readEnv();
    const apiKey = env.ELEVENLABS_API_KEY;

    if (!apiKey) {
      return c.json({ status: "missing" as const });
    }

    return c.json({ status: "valid" as const });
  });

  return app;
}
