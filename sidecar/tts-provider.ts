/**
 * TTS provider factory and readiness checks.
 *
 * Routes TTS creation to the correct provider implementation based on config.
 * Checks provider readiness (platform, binaries, API keys) for dashboard status.
 *
 * Responsibilities:
 * - Create a TtsPlayer for the configured provider (local or ElevenLabs)
 * - Check provider readiness (installed binaries, API keys, platform)
 * - Provide static metadata about available TTS providers
 */

import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createLocalTts } from "./tts.js";
import { createElevenlabsTts } from "./tts-elevenlabs.js";
import { readEnv } from "../services/env.js";

import type { Writable } from "stream";
import type { TtsPlayer } from "./tts.js";
import type { TtsProviderType, TtsProviderConfig, ProviderStatus } from "./types.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the Python venv binary (required for local TTS) */
const PYTHON_VENV_PATH = join(__dirname, ".venv", "bin", "python3");

/** Path to the mic-vpio binary (required for local TTS) */
const MIC_VPIO_PATH = join(__dirname, "mic-vpio");

// ============================================================================
// INTERFACES
// ============================================================================

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
  /** Platform required for this provider (undefined = any platform) */
  requiresPlatform?: "darwin";
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
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create a TtsPlayer for the configured provider.
 * Routes to the local Kokoro provider or ElevenLabs cloud provider.
 *
 * @param options - Provider config, speaker stream, and playback callbacks
 * @returns A TtsPlayer instance ready for playback
 * @throws Error if the provider is not implemented
 */
export async function createTtsForProvider(options: CreateTtsOptions): Promise<TtsPlayer> {
  const { providerConfig, speakerInput, interruptPlayback, resumePlayback } = options;

  switch (providerConfig.provider) {
    case "local":
      return createLocalTts({
        model: providerConfig.local.model,
        voice: providerConfig.local.voice,
        speakerInput,
        interruptPlayback,
        resumePlayback,
      });

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
 *
 * Local: checks macOS platform, Python venv exists, mic-vpio binary exists.
 * ElevenLabs: checks ELEVENLABS_API_KEY is set in .env.
 *
 * @param providerType - The provider to check
 * @returns Readiness status with reason if not ready
 */
export async function getTtsProviderStatus(providerType: TtsProviderType): Promise<ProviderStatus> {
  switch (providerType) {
    case "local": {
      if (process.platform !== "darwin") {
        return { ready: false, reason: "unsupported_platform", detail: "Local TTS requires macOS with Apple Silicon" };
      }
      if (!existsSync(PYTHON_VENV_PATH)) {
        return { ready: false, reason: "not_installed", detail: "Python venv not found at " + PYTHON_VENV_PATH };
      }
      if (!existsSync(MIC_VPIO_PATH)) {
        return { ready: false, reason: "not_installed", detail: "mic-vpio binary not found at " + MIC_VPIO_PATH };
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
      type: "local",
      name: "Local Kokoro",
      description: "On-device TTS via mlx-audio (requires macOS + Apple Silicon)",
      requiresPlatform: "darwin",
    },
    {
      type: "elevenlabs",
      name: "ElevenLabs",
      description: "Cloud TTS via ElevenLabs streaming API",
      requiresApiKey: "ELEVENLABS_API_KEY",
    },
  ];
}
