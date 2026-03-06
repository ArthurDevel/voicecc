/**
 * STT provider factory and readiness checks.
 *
 * Routes STT creation to the correct provider implementation based on config.
 * Checks provider readiness (model files, API keys) for dashboard status.
 *
 * Responsibilities:
 * - Create an SttProcessor for the configured provider (local or ElevenLabs)
 * - Check provider readiness (model files exist, API keys set)
 * - Provide static metadata about available STT providers
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { createLocalStt } from "./stt.js";
import { createElevenlabsStt } from "./stt-elevenlabs.js";
import { readEnv } from "../services/env.js";

import type { SttProcessor } from "./stt.js";
import type { SttProviderType, SttProviderConfig, ProviderStatus } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Standard path where local Whisper model files are stored */
const LOCAL_STT_MODEL_DIR = join(homedir(), ".claude-voice-models", "whisper-small");

/** Required model files for local Whisper STT */
const REQUIRED_MODEL_FILES = [
  "small.en-encoder.int8.onnx",
  "small.en-decoder.int8.onnx",
  "small.en-tokens.txt",
];

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
  /** Platform required for this provider (undefined = any platform) */
  requiresPlatform?: "darwin";
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
 * Routes to the local Whisper provider or ElevenLabs cloud provider.
 *
 * @param options - Provider config with per-provider settings
 * @returns An SttProcessor instance ready for transcription
 * @throws Error if the provider is not implemented
 */
export async function createSttForProvider(options: CreateSttOptions): Promise<SttProcessor> {
  const { providerConfig } = options;

  switch (providerConfig.provider) {
    case "local":
      return createLocalStt(providerConfig.local.modelPath);

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
 *
 * Local: checks that the 3 required Whisper model files exist at the standard path.
 * ElevenLabs: checks ELEVENLABS_API_KEY is set in .env.
 *
 * @param providerType - The provider to check
 * @returns Readiness status with reason if not ready
 */
export async function getSttProviderStatus(providerType: SttProviderType): Promise<ProviderStatus> {
  switch (providerType) {
    case "local": {
      const missingFiles = REQUIRED_MODEL_FILES.filter(
        (file) => !existsSync(join(LOCAL_STT_MODEL_DIR, file))
      );

      if (missingFiles.length > 0) {
        return {
          ready: false,
          reason: "not_installed",
          detail: `Missing model files in ${LOCAL_STT_MODEL_DIR}: ${missingFiles.join(", ")}`,
        };
      }
      return { ready: true };
    }

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
      type: "local",
      name: "Local Whisper",
      description: "On-device STT via sherpa-onnx Whisper ONNX model (offline batch mode)",
    },
    {
      type: "elevenlabs",
      name: "ElevenLabs Scribe",
      description: "Cloud STT via ElevenLabs batch transcription API",
      requiresApiKey: "ELEVENLABS_API_KEY",
    },
  ];
}
