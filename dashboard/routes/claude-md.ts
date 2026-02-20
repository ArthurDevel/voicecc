/**
 * CLAUDE.md read/write API routes.
 *
 * Exposes endpoints to read and write the project's CLAUDE.md file:
 * - GET / -- read the current CLAUDE.md content
 * - POST / -- write new content to CLAUDE.md
 */

import { Hono } from "hono";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const CLAUDE_MD_PATH = join(process.cwd(), "CLAUDE.md");

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for CLAUDE.md operations.
 *
 * @returns Hono instance with GET / and POST / routes
 */
export function claudeMdRoutes(): Hono {
  const app = new Hono();

  /** Read the CLAUDE.md file */
  app.get("/", async (c) => {
    const content = await readFile(CLAUDE_MD_PATH, "utf-8");
    return c.json({ content });
  });

  /** Write new content to CLAUDE.md */
  app.post("/", async (c) => {
    const body = await c.req.json<{ content?: string }>();

    if (body.content === undefined) {
      return c.json({ error: "Missing 'content' in request body" }, 400);
    }

    await writeFile(CLAUDE_MD_PATH, body.content, "utf-8");
    return c.json({ success: true });
  });

  return app;
}
