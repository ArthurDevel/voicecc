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
import twilioSdk from "twilio";
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
import { readEnv } from "../../server/services/env.js";
import { getTunnelUrl } from "../../server/services/tunnel.js";

/** Base URL for the Python voice server API */
const VOICE_API_URL = process.env.VOICE_SERVER_URL ?? "http://localhost:7861";

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
  /** Proxy heartbeat status from the Python voice server */
  app.get("/heartbeat/status", async (c) => {
    try {
      const response = await fetch(`${VOICE_API_URL}/heartbeat/status`);
      const data = await response.json();
      return c.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Proxy error";
      console.error(`[agents] Error proxying heartbeat status: ${message}`);
      return c.json({ error: "Voice server unavailable" }, 502);
    }
  });

  /** Import an agent from a zip upload */
  app.post("/import", async (c) => {
    try {
      const body = await c.req.parseBody();
      const file = body["file"];
      const id = body["id"];

      if (!file || !(file instanceof File)) {
        return c.json({ error: "Missing 'file' field (zip archive)" }, 400);
      }
      if (!id || typeof id !== "string") {
        return c.json({ error: "Missing 'id' field (new agent ID)" }, 400);
      }

      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      await importAgent(id, buffer);
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
      console.error(`[export] Failed for agent ${id}:`, err);
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

  /** Trigger outbound call for an agent via Python voice server */
  app.post("/:id/call", async (c) => {
    const id = c.req.param("id");
    try {
      const envVars = await readEnv();
      const accountSid = envVars.TWILIO_ACCOUNT_SID;
      const authToken = envVars.TWILIO_AUTH_TOKEN;
      const userPhone = envVars.USER_PHONE_NUMBER;
      const tunnelUrl = getTunnelUrl();

      if (!accountSid || !authToken) {
        return c.json({ error: "Twilio credentials not configured" }, 400);
      }
      if (!userPhone) {
        return c.json({ error: "User phone number not configured" }, 400);
      }
      if (!tunnelUrl) {
        return c.json({ error: "Tunnel is not running" }, 400);
      }

      const token = crypto.randomUUID();

      // Register the token with the Python voice server
      const response = await fetch(`${VOICE_API_URL}/register-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          agent_id: id,
          initial_prompt: "The user pressed the 'Call Me' button. Greet them and ask how you can help.",
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Voice server error");
      }

      // Place the actual Twilio call
      const client = twilioSdk(accountSid, authToken);
      const numbers = await client.incomingPhoneNumbers.list({ limit: 1 });
      if (numbers.length === 0) {
        return c.json({ error: "No Twilio phone numbers found on this account" }, 400);
      }

      const tunnelHost = tunnelUrl.replace(/^https?:\/\//, "");
      const twiml = `<Response><Connect><Stream url="wss://${tunnelHost}/media/${token}?agentId=${id}" /></Connect></Response>`;

      const call = await client.calls.create({
        to: userPhone,
        from: numbers[0].phoneNumber,
        twiml,
      });

      return c.json({ success: true, callSid: call.sid });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
