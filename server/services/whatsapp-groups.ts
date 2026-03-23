/**
 * WhatsApp group management for VoiceCC agents.
 *
 * Manages the mapping between VoiceCC agents and WhatsApp groups,
 * and persists mappings + session IDs to disk for resume support.
 *
 * Responsibilities:
 * - Create/leave WhatsApp groups when agents are created/deleted
 * - Sync all agent groups on WhatsApp connect (with duplicate detection)
 * - Map groupJid to agentId for incoming message routing
 * - Store/retrieve Claude session IDs per group for conversation resume
 * - Persist mappings to ~/.voicecc/whatsapp/group-mappings.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getSocket } from "./whatsapp-manager.js";
import { listAgents } from "./agent-store.js";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Prefix used for all VoiceCC WhatsApp group names */
const GROUP_NAME_PREFIX = "[VoiceCC] ";

/** Path to the persisted group mappings file */
const MAPPINGS_FILE_PATH = join(
  process.env.VOICECC_DIR ?? join(homedir(), ".voicecc"),
  "whatsapp",
  "group-mappings.json"
);

// ============================================================================
// TYPES
// ============================================================================

/** Mapping between a WhatsApp group and a VoiceCC agent */
export interface GroupMapping {
  groupJid: string;
  agentId: string;
  lastSessionId: string | null;
}

// ============================================================================
// STATE
// ============================================================================

/** In-memory mappings indexed by groupJid */
let mappings: Map<string, GroupMapping> = new Map();

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create a WhatsApp group for a new agent and register the mapping.
 * Requires an active Baileys socket connection.
 *
 * @param agentId - The agent identifier to create a group for
 */
export async function syncGroupsForNewAgent(agentId: string): Promise<void> {
  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not connected");
  }

  // Check if a mapping already exists for this agent
  const existing = findMappingByAgentId(agentId);
  if (existing) {
    console.log(`WhatsApp group already exists for agent "${agentId}" (${existing.groupJid})`);
    return;
  }

  const groupName = formatGroupName(agentId);
  const result = await sock.groupCreate(groupName, []);

  const mapping: GroupMapping = {
    groupJid: result.id,
    agentId,
    lastSessionId: null,
  };

  mappings.set(result.id, mapping);
  await saveMappings();

  console.log(`Created WhatsApp group "${groupName}" (${result.id}) for agent "${agentId}"`);
}

/**
 * Leave the WhatsApp group for a deleted agent and remove the mapping.
 * Requires an active Baileys socket connection.
 *
 * @param agentId - The agent identifier whose group should be left
 */
export async function syncGroupsForDeletedAgent(agentId: string): Promise<void> {
  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not connected");
  }

  const mapping = findMappingByAgentId(agentId);
  if (!mapping) {
    console.log(`No WhatsApp group mapping found for agent "${agentId}"`);
    return;
  }

  await sock.groupLeave(mapping.groupJid);

  mappings.delete(mapping.groupJid);
  await saveMappings();

  console.log(`Left WhatsApp group (${mapping.groupJid}) for deleted agent "${agentId}"`);
}

/**
 * Sync WhatsApp groups for all agents. For each agent without a mapping,
 * checks if a group named [VoiceCC] <agentId> already exists (duplicate
 * detection). If found, registers the existing group. If not, creates a new one.
 *
 * Called on WhatsApp connect to ensure all agents have groups.
 */
export async function syncAllGroups(): Promise<void> {
  const sock = getSocket();
  if (!sock) {
    throw new Error("WhatsApp socket is not connected");
  }

  // Load persisted mappings first
  await loadMappings();

  const agents = await listAgents();
  const agentsWithoutMapping = agents.filter(
    (agent) => !findMappingByAgentId(agent.id)
  );

  if (agentsWithoutMapping.length === 0) {
    console.log("All agents already have WhatsApp group mappings.");
    return;
  }

  // Fetch existing WhatsApp groups for duplicate detection
  const existingGroups = await sock.groupFetchAllParticipating();
  const groupsByName = new Map<string, string>();
  for (const [jid, metadata] of Object.entries(existingGroups)) {
    const groupMetadata = metadata as { subject: string };
    groupsByName.set(groupMetadata.subject, jid);
  }

  let synced = 0;

  for (const agent of agentsWithoutMapping) {
    const groupName = formatGroupName(agent.id);
    const existingJid = groupsByName.get(groupName);

    try {
      if (existingJid) {
        // Register existing group instead of creating a duplicate
        const mapping: GroupMapping = {
          groupJid: existingJid,
          agentId: agent.id,
          lastSessionId: null,
        };
        mappings.set(existingJid, mapping);
        console.log(`Registered existing WhatsApp group "${groupName}" (${existingJid}) for agent "${agent.id}"`);
      } else {
        // Create a new group
        const result = await sock.groupCreate(groupName, []);
        const mapping: GroupMapping = {
          groupJid: result.id,
          agentId: agent.id,
          lastSessionId: null,
        };
        mappings.set(result.id, mapping);
        console.log(`Created WhatsApp group "${groupName}" (${result.id}) for agent "${agent.id}"`);
      }

      // Save after each successful creation so partial progress is persisted
      await saveMappings();
      synced++;

      // Delay between group creations to avoid WhatsApp rate-limiting
      if (synced < agentsWithoutMapping.length) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    } catch (err: unknown) {
      console.error(`Failed to sync WhatsApp group for agent "${agent.id}": ${err}`);
    }
  }

  console.log(`WhatsApp group sync complete. ${synced}/${agentsWithoutMapping.length} agent(s) synced.`);
}

/**
 * Look up which agent a WhatsApp group belongs to.
 *
 * @param groupJid - The WhatsApp group JID
 * @returns The agent ID, or undefined if the group is not mapped
 */
export function getAgentIdForGroup(groupJid: string): string | undefined {
  return mappings.get(groupJid)?.agentId;
}

/**
 * Get the stored Claude session ID for a group (used for conversation resume).
 *
 * @param groupJid - The WhatsApp group JID
 * @returns The last session ID, or null if none stored
 */
export function getLastSessionId(groupJid: string): string | null {
  return mappings.get(groupJid)?.lastSessionId ?? null;
}

/**
 * Update the stored Claude session ID for a group and persist to disk.
 *
 * @param groupJid - The WhatsApp group JID
 * @param sessionId - The Claude session ID to store
 */
export async function setLastSessionId(groupJid: string, sessionId: string): Promise<void> {
  const mapping = mappings.get(groupJid);
  if (!mapping) {
    throw new Error(`No mapping found for group "${groupJid}"`);
  }

  mapping.lastSessionId = sessionId;
  await saveMappings();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Format the WhatsApp group name for an agent.
 *
 * @param agentId - The agent identifier
 * @returns The formatted group name, e.g. "[VoiceCC] my-agent"
 */
export function formatGroupName(agentId: string): string {
  return `${GROUP_NAME_PREFIX}${agentId}`;
}

/**
 * Load group mappings from disk. Creates an empty mappings file if none exists.
 * Called on startup and before syncAllGroups.
 */
export async function loadMappings(): Promise<void> {
  try {
    const raw = await readFile(MAPPINGS_FILE_PATH, "utf-8");
    const parsed: GroupMapping[] = JSON.parse(raw);

    mappings = new Map();
    for (const mapping of parsed) {
      mappings.set(mapping.groupJid, mapping);
    }

    console.log(`Loaded ${mappings.size} WhatsApp group mapping(s) from disk.`);
  } catch {
    // File does not exist yet -- start with empty mappings
    mappings = new Map();
  }
}

/**
 * Persist current group mappings to disk as JSON.
 */
export async function saveMappings(): Promise<void> {
  const data = Array.from(mappings.values());

  await mkdir(dirname(MAPPINGS_FILE_PATH), { recursive: true });
  await writeFile(MAPPINGS_FILE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Find a mapping by agent ID (reverse lookup).
 *
 * @param agentId - The agent identifier to search for
 * @returns The mapping, or undefined if not found
 */
export function findMappingByAgentId(agentId: string): GroupMapping | undefined {
  for (const mapping of mappings.values()) {
    if (mapping.agentId === agentId) {
      return mapping;
    }
  }
  return undefined;
}
