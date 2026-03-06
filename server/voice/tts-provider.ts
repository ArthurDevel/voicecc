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

/** ElevenLabs API base URL */
const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

/** Known Kokoro voice options */
const KOKORO_VOICES: VoiceOption[] = [
  { id: "af_heart", name: "Heart (Female)" },
  { id: "af_alloy", name: "Alloy (Female)" },
  { id: "af_aoede", name: "Aoede (Female)" },
  { id: "af_bella", name: "Bella (Female)" },
  { id: "af_jessica", name: "Jessica (Female)" },
  { id: "af_kore", name: "Kore (Female)" },
  { id: "af_nicole", name: "Nicole (Female)" },
  { id: "af_nova", name: "Nova (Female)" },
  { id: "af_river", name: "River (Female)" },
  { id: "af_sarah", name: "Sarah (Female)" },
  { id: "af_sky", name: "Sky (Female)" },
  { id: "am_adam", name: "Adam (Male)" },
  { id: "am_echo", name: "Echo (Male)" },
  { id: "am_eric", name: "Eric (Male)" },
  { id: "am_liam", name: "Liam (Male)" },
  { id: "am_michael", name: "Michael (Male)" },
  { id: "am_onyx", name: "Onyx (Male)" },
];

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
 * List available voices for a TTS provider.
 * Local: returns a hardcoded list of known Kokoro voices.
 * ElevenLabs: fetches available voices from the API.
 *
 * @param providerType - The provider to list voices for
 * @returns Array of voice options
 */
export async function listVoicesForProvider(
  providerType: TtsProviderType,
): Promise<VoiceOption[]> {
  switch (providerType) {
    case "local":
      return KOKORO_VOICES;

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
