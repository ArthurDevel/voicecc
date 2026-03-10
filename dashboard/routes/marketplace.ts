/**
 * Marketplace API routes.
 *
 * Provides endpoints for browsing, publishing, downloading, installing,
 * and deleting agents from the community marketplace (S3-backed):
 * - GET / -- list all published agents (CORS enabled)
 * - GET /:id/download -- download agent zip (CORS enabled)
 * - GET /:id -- get single agent metadata (CORS enabled)
 * - POST /publish -- publish a local agent to the marketplace
 * - POST /:id/install -- download from S3 and import locally
 * - DELETE /:id -- remove an agent from the marketplace
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  listMarketplaceAgents,
  getMarketplaceAgent,
  downloadAgent,
  publishAgent,
  deleteMarketplaceAgent,
} from "../../server/services/marketplace.js";
import type { PublishAgentParams } from "../../server/services/marketplace.js";
import { importAgent } from "../../server/services/agent-store.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for marketplace operations.
 *
 * @returns Hono instance with marketplace CRUD routes
 */
export function marketplaceRoutes(): Hono {
  const app = new Hono();

  const openCors = cors({ origin: "*" });

  // /publish and /:id/download MUST be registered before /:id to avoid route conflicts

  /** List all published agents */
  app.get("/", openCors, async (c) => {
    try {
      const agents = await listMarketplaceAgents();
      return c.json(agents);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Publish a local agent to the marketplace */
  app.post("/publish", async (c) => {
    try {
      const body = await c.req.json<PublishAgentParams>();
      const agent = await publishAgent(body);
      return c.json({ success: true, agent });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Download agent zip by marketplace ID */
  app.get("/:id/download", openCors, async (c) => {
    const id = c.req.param("id");
    try {
      const buffer = await downloadAgent(id);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${id}.zip"`,
        },
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  /** Install a marketplace agent locally (download from S3 + import) */
  app.post("/:id/install", async (c) => {
    const id = c.req.param("id");
    try {
      const body = await c.req.json<{ localId: string }>();
      if (!body.localId) {
        return c.json({ error: "Missing 'localId' in request body" }, 400);
      }
      const zipBuffer = await downloadAgent(id);
      await importAgent(body.localId, zipBuffer);
      return c.json({ success: true, id: body.localId });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  /** Get metadata for a single marketplace agent */
  app.get("/:id", openCors, async (c) => {
    const id = c.req.param("id");
    try {
      const agent = await getMarketplaceAgent(id);
      return c.json(agent);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  /** Delete an agent from the marketplace */
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await deleteMarketplaceAgent(id);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return app;
}
