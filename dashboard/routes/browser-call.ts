/**
 * Browser call status API route.
 *
 * Browser calling is always enabled. This route exposes the call base URL
 * which now points through the dashboard (since tunnel targets dashboard port).
 *
 * - GET /status -- returns call base URL
 */

import { Hono } from "hono";
import { getCallBaseUrl } from "../../server/services/browser-call-manager.js";

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for browser call status.
 * The call URL now routes through the dashboard voice proxy (/api/voice/).
 *
 * @returns Hono instance with status route
 */
export function browserCallRoutes(): Hono {
  const app = new Hono();

  /** Get call base URL (tunnel or localhost, pointing at dashboard) */
  app.get("/status", (c) => {
    return c.json({ callBaseUrl: getCallBaseUrl() });
  });

  return app;
}
