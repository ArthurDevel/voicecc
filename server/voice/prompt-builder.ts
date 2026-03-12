/**
 * Shared prompt builder for all session types (voice, text).
 *
 * Loads the base system.md template once at module level and replaces the
 * <<MODE_OVERLAY>> placeholder with the appropriate overlay file for the
 * given session mode. For agent sessions, also injects SOUL/MEMORY/HEARTBEAT
 * files and the agent working directory.
 *
 * - buildAgentPrompt: full agent prompt with mode overlay + agent files
 * - buildDefaultPrompt: base prompt with mode overlay only (no agent files)
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { getAgent, AGENTS_DIR } from "../services/agent-store.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, "..", "..", "init", "defaults");

/** Base system prompt template with <<MODE_OVERLAY>> placeholder */
const BASE_SYSTEM_PROMPT = readFileSync(join(DEFAULTS_DIR, "system.md"), "utf-8").trim();

/** Voice-specific behavioral instructions */
const VOICE_OVERLAY = readFileSync(join(DEFAULTS_DIR, "system-voice-overlay.md"), "utf-8").trim();

/** Text-specific behavioral instructions */
const TEXT_OVERLAY = readFileSync(join(DEFAULTS_DIR, "system-text-overlay.md"), "utf-8").trim();

/** Map of session mode to overlay content */
const OVERLAY_MAP: Record<SessionMode, string> = {
  voice: VOICE_OVERLAY,
  text: TEXT_OVERLAY,
};

// ============================================================================
// TYPES
// ============================================================================

/** Session mode determines which overlay is injected into the base prompt */
export type SessionMode = "voice" | "text";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Build a complete system prompt for an agent session.
 *
 * Loads the agent's SOUL.md, MEMORY.md, and HEARTBEAT.md via getAgent(),
 * replaces <<MODE_OVERLAY>>, <<AGENT_DIR>>, and <<AGENT_FILES>> placeholders
 * in the base system prompt.
 *
 * @param agentId - The agent identifier to load files for
 * @param mode - Session mode ("voice" or "text") to select the overlay
 * @returns Complete system prompt string ready for customSystemPrompt
 */
export async function buildAgentPrompt(agentId: string, mode: SessionMode): Promise<string> {
  const agent = await getAgent(agentId);
  const agentDir = join(AGENTS_DIR, agentId);

  const agentFiles = [
    `<SOUL.md>\n${agent.soulMd}\n</SOUL.md>`,
    `<HEARTBEAT.md>\n${agent.heartbeatMd}\n</HEARTBEAT.md>`,
    `<MEMORY.md>\n${agent.memoryMd}\n</MEMORY.md>`,
  ].join("\n\n");

  return applyOverlay(BASE_SYSTEM_PROMPT, mode)
    .replaceAll("<<AGENT_DIR>>", agentDir)
    .replace("<<AGENT_FILES>>", agentFiles);
}

/**
 * Build a base system prompt without agent files.
 *
 * Replaces <<MODE_OVERLAY>> with the appropriate overlay for the given mode.
 * Used for non-agent sessions (e.g. claude-session fallback, default Twilio calls).
 *
 * @param mode - Session mode ("voice" or "text") to select the overlay
 * @returns System prompt string with overlay applied but no agent files
 */
export function buildDefaultPrompt(mode: SessionMode): string {
  return applyOverlay(BASE_SYSTEM_PROMPT, mode);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Replace <<MODE_OVERLAY>> placeholders in a template with the overlay for the given mode.
 *
 * @param template - Base prompt template containing <<MODE_OVERLAY>> placeholders
 * @param mode - Session mode to select the overlay content
 * @returns Template with all <<MODE_OVERLAY>> placeholders replaced
 */
function applyOverlay(template: string, mode: SessionMode): string {
  const overlay = OVERLAY_MAP[mode];
  if (!overlay) {
    throw new Error(`Unknown session mode: "${mode}"`);
  }
  return template.replaceAll("<<MODE_OVERLAY>>", overlay);
}
