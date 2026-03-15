/**
 * TTS provider factory and readiness checks.
 *
 * Routes TTS creation to the ElevenLabs provider implementation.
 * Checks provider readiness (API keys) for dashboard status.
 *
 * Responsibilities:
 * - Create a TtsPlayer for the configured provider
 * - Check provider readiness (API keys set)
 * - Provide static metadata about available TTS providers
 */

import { createElevenlabsTts } from "./tts-elevenlabs.js";
import { readEnv } from "../services/env.js";

import type { Writable } from "stream";
import type { TtsPlayer, TtsProviderType, TtsProviderConfig, ProviderStatus } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** ElevenLabs API base URL */
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * A voice option returned by listVoicesForProvider.
 */
export interface VoiceOption {
  id: string;
  name: string;
}

/**
 * Metadata about a TTS provider for display in the dashboard.
 */
export interface TtsProviderInfo {
  /** Provider type identifier */
  type: TtsProviderType;
  /** Human-readable provider name */
  name: string;
  /** Short description of the provider */
  description: string;
  /** Environment variable name for the API key (undefined = no key needed) */
  requiresApiKey?: string;
}

/**
 * Options for creating a TTS player via the provider factory.
 */
export interface CreateTtsOptions {
  /** Provider configuration (which provider + per-provider settings) */
  providerConfig: TtsProviderConfig;
  /** Writable stream for PCM audio output */
  speakerInput: Writable;
  /** Callback to clear the playback buffer on interruption */
  interruptPlayback: () => void;
  /** Callback to resume playback after an interrupt */
  resumePlayback: () => void;
  /** Callback to pause the playback buffer (suspend output without cancelling) */
  pausePlayback: () => void;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create a TtsPlayer for the configured provider.
 *
 * @param options - Provider config, speaker stream, and playback callbacks
 * @returns A TtsPlayer instance ready for playback
 * @throws Error if the provider is not implemented
 */
export async function createTtsForProvider(options: CreateTtsOptions): Promise<TtsPlayer> {
  const { providerConfig, speakerInput, interruptPlayback, resumePlayback } = options;

  switch (providerConfig.provider) {
    case "elevenlabs":
      return createElevenlabsTts({
        apiKey: providerConfig.elevenlabs.apiKey,
        voiceId: providerConfig.elevenlabs.voiceId,
        modelId: providerConfig.elevenlabs.modelId,
        speakerInput,
        interruptPlayback,
        resumePlayback,
      });

    default:
      throw new Error(`Unknown TTS provider: ${providerConfig.provider}`);
  }
}

/**
 * Check whether a TTS provider is ready to use.
 * Checks ELEVENLABS_API_KEY is set in .env.
 *
 * @param providerType - The provider to check
 * @returns Readiness status with reason if not ready
 */
export async function getTtsProviderStatus(providerType: TtsProviderType): Promise<ProviderStatus> {
  switch (providerType) {
    case "elevenlabs": {
      const env = await readEnv();
      if (!env.ELEVENLABS_API_KEY) {
        return { ready: false, reason: "missing_api_key", detail: "ELEVENLABS_API_KEY is not set in .env" };
      }
      return { ready: true };
    }

    default:
      throw new Error(`Unknown TTS provider: ${providerType}`);
  }
}

/**
 * List available voices for a TTS provider.
 * Fetches available voices from the ElevenLabs API.
 *
 * @param providerType - The provider to list voices for
 * @returns Array of voice options
 */
export async function listVoicesForProvider(
  providerType: TtsProviderType,
): Promise<VoiceOption[]> {
  switch (providerType) {
    case "elevenlabs": {
      const res = await fetch(`${ELEVENLABS_API_BASE}/voices`);
      if (!res.ok) throw new Error(`ElevenLabs API error: ${res.status}`);
      const data = (await res.json()) as { voices: Array<{ voice_id: string; name: string }> };
      return data.voices.map((v) => ({ id: v.voice_id, name: v.name }));
    }

    default:
      throw new Error(`Unknown TTS provider: ${providerType}`);
  }
}

/**
 * Get the list of all known TTS providers with metadata.
 *
 * @returns Static array of TTS provider info
 */
export function getAvailableTtsProviders(): TtsProviderInfo[] {
  return [
    {
      type: "elevenlabs",
      name: "ElevenLabs",
      description: "Cloud TTS via ElevenLabs streaming API",
      requiresApiKey: "ELEVENLABS_API_KEY",
    },
  ];
}
