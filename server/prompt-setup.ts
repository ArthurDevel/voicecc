import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const initDefaultsDir = join(__dirname, "..", "init", "defaults");

export interface PromptSetupOptions {
  agentName?: string;
  heartbeat?: string;
  customPrompt?: string;
  includeVoiceOverlay?: boolean;
  includeHeartbeat?: boolean;
}

const DEFAULTS: PromptSetupOptions = {
  includeVoiceOverlay: true,
  includeHeartbeat: true,
};

/**
 * Assembles the full system prompt by reading init templates and
 * inserting placeholders. This logic is shared across all voice
 * transports (Twilio, browser WebRTC, etc.).
 */
export function buildSystemPrompt(options: PromptSetupOptions = {}): string {
  const opts = { ...DEFAULTS, ...options };

  const parts: string[] = [];

  // Base soul/persona
  const soulPath = join(initDefaultsDir, "soul.md");
  try {
    parts.push(readFileSync(soulPath, "utf-8").trim());
  } catch {
    parts.push("You are a helpful assistant.");
  }

  // Voice overlay
  if (opts.includeVoiceOverlay) {
    const voiceOverlayPath = join(initDefaultsDir, "system-voice-overlay.md");
    try {
      parts.push(readFileSync(voiceOverlayPath, "utf-8").trim());
    } catch {
      // no-op if missing
    }
  }

  // Heartbeat instruction
  if (opts.includeHeartbeat) {
    const heartbeatPath = join(initDefaultsDir, "system-heartbeat.md");
    try {
      parts.push(readFileSync(heartbeatPath, "utf-8").trim());
    } catch {
      // no-op if missing
    }
  }

  let prompt = parts.join("\n\n");

  // Insert placeholders
  if (opts.agentName) {
    prompt = prompt.replace(/{{AGENT_NAME}}/g, opts.agentName);
  }
  if (opts.heartbeat) {
    prompt = prompt.replace(/{{HEARTBEAT}}/g, opts.heartbeat);
  }
  if (opts.customPrompt) {
    prompt = prompt.replace(/{{CUSTOM_PROMPT}}/g, opts.customPrompt);
  }

  return prompt;
}
