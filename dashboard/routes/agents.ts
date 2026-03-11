/**
 * Agent management API routes.
 *
 * CRUD operations for agents and triggers for outbound calls:
 * - GET /heartbeat/status -- last heartbeat result per agent
 * - GET / -- list all agents (summary)
 * - GET /:id -- get full agent data
 * - POST / -- create a new agent
 * - DELETE /:id -- delete an agent
 * - POST /:id/call -- trigger outbound call for an agent
 */

import { Hono } from "hono";
import {
  listAgents,
  getAgent,
  createAgent,
  deleteAgent,
  updateAgentConfig,
  exportAgent,
  importAgent,
} from "../../server/services/agent-store.js";
import type { AgentConfig } from "../../server/services/agent-store.js";
import { getHeartbeatStatus, initiateAgentCall } from "../../server/services/heartbeat.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for agent management.
 *
 * @returns Hono instance with agent CRUD and call routes
 */
export function agentsRoutes(): Hono {
  const app = new Hono();

  // /heartbeat/status and /import MUST be registered before /:id to avoid route conflict
  /** Get last heartbeat result per agent */
  app.get("/heartbeat/status", (c) => {
    const status = getHeartbeatStatus();
    return c.json(status);
  });

  /** Import an agent from a zip upload */
  app.post("/import", async (c) => {
    try {
      console.log("[import] Parsing body...");
      const body = await c.req.parseBody();
      const file = body["file"];
      const id = body["id"];
      console.log("[import] file type:", typeof file, file instanceof File ? "File" : file?.constructor?.name);
      console.log("[import] id:", id);

      if (!file || !(file instanceof File)) {
        return c.json({ error: "Missing 'file' field (zip archive)" }, 400);
      }
      if (!id || typeof id !== "string") {
        return c.json({ error: "Missing 'id' field (new agent ID)" }, 400);
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log("[import] Buffer size:", buffer.length);
      await importAgent(id, buffer);
      console.log("[import] Success, agent:", id);
      return c.json({ success: true, id });
    } catch (err) {
      console.error("[import] Error:", err);
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** List all agents with summary info */
  app.get("/", async (c) => {
    const agents = await listAgents();
    return c.json(agents);
  });

  /** Export an agent as a zip download */
  app.get("/:id/export", async (c) => {
    const id = c.req.param("id");
    try {
      const zipBuffer = await exportAgent(id);
      const body = new Uint8Array(zipBuffer);
      return new Response(body, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${id}.zip"`,
          "Content-Length": String(body.byteLength),
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  /** Get full agent data by ID */
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const agent = await getAgent(id);
      return c.json(agent);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  /** Create a new agent */
  app.post("/", async (c) => {
    const body = await c.req.json<{
      id: string;
      soulMd?: string;
      heartbeatMd?: string;
      config?: Partial<AgentConfig>;
    }>();

    try {
      await createAgent(body.id, body.soulMd, body.heartbeatMd, body.config);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Update an agent's config */
  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ config: Partial<AgentConfig> }>();
    try {
      const updated = await updateAgentConfig(id, body.config);
      return c.json({ config: updated });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Delete an agent by ID */
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await deleteAgent(id);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  /** Trigger outbound call for an agent */
  app.post("/:id/call", async (c) => {
    const id = c.req.param("id");
    try {
      const agent = await getAgent(id);
      await initiateAgentCall(agent, { initialPrompt: "The user pressed the 'Call Me' button. Greet them and ask how you can help." });
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
