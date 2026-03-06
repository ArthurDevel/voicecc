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
} from "../../services/agent-store.js";
import type { AgentConfig } from "../../services/agent-store.js";
import { getHeartbeatStatus, initiateAgentCall } from "../../services/heartbeat.js";

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

  // /heartbeat/status MUST be registered before /:id to avoid route conflict
  /** Get last heartbeat result per agent */
  app.get("/heartbeat/status", (c) => {
    const status = getHeartbeatStatus();
    return c.json(status);
  });

  /** List all agents with summary info */
  app.get("/", async (c) => {
    const agents = await listAgents();
    return c.json(agents);
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
      soulMd: string;
      heartbeatMd: string;
      config: AgentConfig;
    }>();

    try {
      await createAgent(body.id, body.soulMd, body.heartbeatMd, body.config);
      return c.json({ success: true });
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
      await initiateAgentCall(agent);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
