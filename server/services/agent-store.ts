/**
 * File-based CRUD for agent data at ~/.claude-voice-agents/<agentId>/.
 *
 * Each agent directory contains SOUL.md, MEMORY.md, HEARTBEAT.md, and config.json.
 * The agent reads/writes its own files during voice sessions via Claude Code SDK.
 * This module is used by the heartbeat scheduler and the dashboard API.
 *
 * - List agents (summary from config.json only)
 * - Get full agent data (all four files)
 * - Create agent with initial files
 * - Delete agent directory
 */

import { readFileSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rm, access } from "fs/promises";
import { dirname, join } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// ============================================================================
// CONSTANTS
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, "..", "..", "init", "defaults");

/** Root directory for all agent data */
export const AGENTS_DIR = join(homedir(), ".claude-voice-agents");

/** Default file contents for new agents, read from init/defaults/ */
const DEFAULT_SOUL_MD = readFileSync(join(DEFAULTS_DIR, "soul.md"), "utf-8");
const DEFAULT_HEARTBEAT_MD = readFileSync(join(DEFAULTS_DIR, "heartbeat.md"), "utf-8");

/** Agent ID must be alphanumeric + hyphens, 1-50 chars */
const AGENT_ID_REGEX = /^[a-zA-Z0-9-]{1,50}$/;

// ============================================================================
// TYPES
// ============================================================================

/** Voice preference for a single TTS provider */
export interface VoicePreference {
  id: string;
  name: string;
}

/** Per-provider voice preferences */
export interface AgentVoiceConfig {
  elevenlabs?: VoicePreference;
  local?: VoicePreference;
}

/** Configuration stored in config.json for each agent */
export interface AgentConfig {
  heartbeatIntervalMinutes: number;
  enabled: boolean;
  voice?: AgentVoiceConfig;
}

/** Full agent data including all file contents */
export interface Agent {
  id: string;
  soulMd: string;
  memoryMd: string;
  heartbeatMd: string;
  config: AgentConfig;
}

/** Lightweight agent summary derived from config.json only */
export interface AgentSummary {
  id: string;
  enabled: boolean;
  heartbeatIntervalMinutes: number;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * List all agents with summary info parsed from config.json.
 * Returns an empty array if AGENTS_DIR does not exist.
 *
 * @returns Array of agent summaries
 */
export async function listAgents(): Promise<AgentSummary[]> {
  const dirExists = await access(AGENTS_DIR).then(() => true).catch(() => false);
  if (!dirExists) return [];

  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());

  const summaries: AgentSummary[] = [];
  for (const dir of dirs) {
    const configPath = join(AGENTS_DIR, dir.name, "config.json");
    const raw = await readFile(configPath, "utf-8").catch(() => null);
    if (!raw) continue;

    const config: AgentConfig = JSON.parse(raw);
    summaries.push({
      id: dir.name,
      enabled: config.enabled,
      heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
    });
  }

  return summaries;
}

/**
 * Get full agent data by reading all four files from the agent directory.
 * Throws if the agent does not exist.
 *
 * @param id - Agent identifier
 * @returns Full agent data including SOUL.md, MEMORY.md, HEARTBEAT.md, and config
 */
export async function getAgent(id: string): Promise<Agent> {
  const agentDir = join(AGENTS_DIR, id);
  await assertAgentExists(agentDir, id);

  const [soulMd, memoryMd, heartbeatMd, configRaw] = await Promise.all([
    readFile(join(agentDir, "SOUL.md"), "utf-8"),
    readFile(join(agentDir, "MEMORY.md"), "utf-8"),
    readFile(join(agentDir, "HEARTBEAT.md"), "utf-8"),
    readFile(join(agentDir, "config.json"), "utf-8"),
  ]);

  return {
    id,
    soulMd,
    memoryMd,
    heartbeatMd,
    config: JSON.parse(configRaw),
  };
}

/**
 * Create a new agent directory with SOUL.md, empty MEMORY.md, HEARTBEAT.md, and config.json.
 * Creates AGENTS_DIR if it does not exist. Throws if agent already exists.
 *
 * @param id - Agent identifier (alphanumeric + hyphens, 1-50 chars)
 * @param soulMd - Contents for SOUL.md
 * @param heartbeatMd - Contents for HEARTBEAT.md
 * @param config - Agent configuration
 */
export async function createAgent(
  id: string,
  soulMd?: string,
  heartbeatMd?: string,
  config?: Partial<AgentConfig>,
): Promise<void> {
  validateAgentId(id);

  const agentDir = join(AGENTS_DIR, id);
  const dirExists = await access(agentDir).then(() => true).catch(() => false);
  if (dirExists) throw new Error(`Agent "${id}" already exists`);

  // Creates both AGENTS_DIR and the agent subdirectory in one call
  await mkdir(agentDir, { recursive: true });

  const finalConfig: AgentConfig = {
    heartbeatIntervalMinutes: config?.heartbeatIntervalMinutes ?? 10,
    enabled: config?.enabled ?? true,
  };

  await Promise.all([
    writeFile(join(agentDir, "SOUL.md"), soulMd || DEFAULT_SOUL_MD, "utf-8"),
    writeFile(join(agentDir, "MEMORY.md"), "", "utf-8"),
    writeFile(join(agentDir, "HEARTBEAT.md"), heartbeatMd || DEFAULT_HEARTBEAT_MD, "utf-8"),
    writeFile(join(agentDir, "config.json"), JSON.stringify(finalConfig, null, 2), "utf-8"),
  ]);
}

/**
 * Delete an agent by recursively removing its directory.
 * Throws if the agent does not exist.
 *
 * @param id - Agent identifier
 */
export async function deleteAgent(id: string): Promise<void> {
  const agentDir = join(AGENTS_DIR, id);
  await assertAgentExists(agentDir, id);
  await rm(agentDir, { recursive: true });
}

/**
 * Update an agent's config.json by merging partial updates.
 * Throws if the agent does not exist.
 *
 * @param id - Agent identifier
 * @param patch - Partial config to merge
 * @returns The updated full config
 */
export async function updateAgentConfig(
  id: string,
  patch: Partial<AgentConfig>,
): Promise<AgentConfig> {
  const agentDir = join(AGENTS_DIR, id);
  await assertAgentExists(agentDir, id);

  const configPath = join(agentDir, "config.json");
  const existing: AgentConfig = JSON.parse(await readFile(configPath, "utf-8"));
  const updated: AgentConfig = { ...existing, ...patch };
  await writeFile(configPath, JSON.stringify(updated, null, 2), "utf-8");
  return updated;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate that an agent ID is filesystem-safe.
 * Must be alphanumeric + hyphens only, 1-50 characters.
 *
 * @param id - Agent identifier to validate
 */
function validateAgentId(id: string): void {
  if (!AGENT_ID_REGEX.test(id)) {
    throw new Error(
      `Invalid agent ID "${id}". Must be 1-50 characters, alphanumeric and hyphens only.`,
    );
  }
}

/**
 * Assert that an agent directory exists on disk.
 * Throws with a clear message if it does not.
 *
 * @param agentDir - Absolute path to the agent directory
 * @param id - Agent identifier (used in error message)
 */
async function assertAgentExists(agentDir: string, id: string): Promise<void> {
  const exists = await access(agentDir).then(() => true).catch(() => false);
  if (!exists) throw new Error(`Agent "${id}" not found`);
}
