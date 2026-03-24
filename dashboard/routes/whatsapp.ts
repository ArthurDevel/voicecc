/**
 * WhatsApp management API routes.
 *
 * Provides endpoints for checking WhatsApp connection status (including QR code),
 * listing current group-to-agent mappings, and sending outbound messages.
 *
 * Responsibilities:
 * - GET /status -- returns connection state and QR code string
 * - GET /groups -- lists current group mappings with agent IDs
 * - POST /send -- sends a message to an agent's WhatsApp group (used by heartbeat)
 */

import { Hono } from "hono";
import { getConnectionState, isConnected, getSocket } from "../../server/services/whatsapp-manager.js";
import { loadMappings, findMappingByAgentId } from "../../server/services/whatsapp-groups.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Path to the persisted group mappings file */
const MAPPINGS_FILE_PATH = join(
  process.env.VOICECC_DIR ?? join(homedir(), ".voicecc"),
  "whatsapp",
  "group-mappings.json"
);

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for WhatsApp operations.
 *
 * @returns Hono instance with GET /status, GET /groups, and POST /send routes
 */
export function whatsappRoutes(): Hono {
  const app = new Hono();

  /** Get WhatsApp connection state and QR code string */
  app.get("/status", (c) => {
    const state = getConnectionState();
    return c.json(state);
  });

  /** List current group mappings with agent IDs */
  app.get("/groups", async (c) => {
    try {
      const raw = await readFile(MAPPINGS_FILE_PATH, "utf-8");
      const groups = JSON.parse(raw);
      return c.json({ groups });
    } catch {
      // No mappings file yet -- return empty list
      return c.json({ groups: [] });
    }
  });

  /**
   * Send a message to an agent's WhatsApp group.
   * Used by the Python heartbeat when outboundChannel is "whatsapp".
   *
   * Body: { agentId: string, text: string }
   * Returns 404 if no group mapping found, 503 if WhatsApp not connected.
   */
  app.post("/send", async (c) => {
    const body = await c.req.json<{ agentId: string; text: string }>();
    const { agentId, text } = body;

    if (!agentId || !text) {
      return c.json({ error: "agentId and text are required" }, 400);
    }

    if (!isConnected()) {
      return c.json({ error: "WhatsApp is not connected" }, 503);
    }

    const sock = getSocket();
    if (!sock) {
      return c.json({ error: "WhatsApp socket not available" }, 503);
    }

    // Reverse lookup: find the groupJid for this agentId
    const mapping = findMappingByAgentId(agentId);
    if (!mapping) {
      return c.json({ error: `No WhatsApp group mapping found for agent "${agentId}"` }, 404);
    }

    await sock.sendMessage(mapping.groupJid, { text: `[voicecc] ${text}` });
    console.log(`[whatsapp] Sent outbound message to group ${mapping.groupJid} for agent "${agentId}"`);

    return c.json({ ok: true });
  });

  return app;
}
