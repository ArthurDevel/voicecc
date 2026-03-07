/**
 * STT provider factory and readiness checks.
 *
 * Routes STT creation to the ElevenLabs provider implementation.
 * Checks provider readiness (API keys) for dashboard status.
 *
 * Responsibilities:
 * - Create an SttProcessor for the configured provider
 * - Check provider readiness (API keys set)
 * - Provide static metadata about available STT providers
 */

import { createElevenlabsStt } from "./stt-elevenlabs.js";
import { readEnv } from "../services/env.js";

import type { SttProcessor, SttProviderType, SttProviderConfig, ProviderStatus } from "./types.js";

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Metadata about an STT provider for display in the dashboard.
 */
export interface SttProviderInfo {
  /** Provider type identifier */
  type: SttProviderType;
  /** Human-readable provider name */
  name: string;
  /** Short description of the provider */
  description: string;
  /** Environment variable name for the API key (undefined = no key needed) */
  requiresApiKey?: string;
}

/**
 * Options for creating an STT processor via the provider factory.
 */
export interface CreateSttOptions {
  /** Provider configuration (which provider + per-provider settings) */
  providerConfig: SttProviderConfig;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create an SttProcessor for the configured provider.
 *
 * @param options - Provider config with per-provider settings
 * @returns An SttProcessor instance ready for transcription
 * @throws Error if the provider is not implemented
 */
export async function createSttForProvider(options: CreateSttOptions): Promise<SttProcessor> {
  const { providerConfig } = options;

  switch (providerConfig.provider) {
    case "elevenlabs":
      return createElevenlabsStt({
        apiKey: providerConfig.elevenlabs.apiKey,
        modelId: providerConfig.elevenlabs.modelId,
      });

    default:
      throw new Error(`Unknown STT provider: ${providerConfig.provider}`);
  }
}

/**
 * Check whether an STT provider is ready to use.
 * Checks ELEVENLABS_API_KEY is set in .env.
 *
 * @param providerType - The provider to check
 * @returns Readiness status with reason if not ready
 */
export async function getSttProviderStatus(providerType: SttProviderType): Promise<ProviderStatus> {
  switch (providerType) {
    case "elevenlabs": {
      const env = await readEnv();
      if (!env.ELEVENLABS_API_KEY) {
        return { ready: false, reason: "missing_api_key", detail: "ELEVENLABS_API_KEY is not set in .env" };
      }
      return { ready: true };
    }

    default:
      throw new Error(`Unknown STT provider: ${providerType}`);
  }
}

/**
 * Get the list of all known STT providers with metadata.
 *
 * @returns Static array of STT provider info
 */
export function getAvailableSttProviders(): SttProviderInfo[] {
  return [
    {
      type: "elevenlabs",
      name: "ElevenLabs Scribe",
      description: "Cloud STT via ElevenLabs batch transcription API",
      requiresApiKey: "ELEVENLABS_API_KEY",
    },
  ];
}
