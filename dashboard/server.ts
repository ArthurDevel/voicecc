/**
 * Dashboard Hono server -- serves the React frontend and mounts API routes.
 *
 * Thin wiring file that creates the Hono app and starts listening:
 * - Mount all API route groups under /api/*
 * - Serve the Vite build output as static files
 * - SPA fallback for client-side routing
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync } from "fs";
import { access } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

import { claudeMdRoutes } from "./routes/claude-md.js";
import { conversationRoutes } from "./routes/conversations.js";
import { settingsRoutes } from "./routes/settings.js";
import { voiceRoutes } from "./routes/voice.js";
import { ngrokRoutes } from "./routes/ngrok.js";
import { twilioRoutes, setDashboardPort } from "./routes/twilio.js";
import { webrtcRoutes } from "./routes/webrtc.js";
import { mcpServersRoutes } from "./routes/mcp-servers.js";
import { authRoutes } from "./routes/auth.js";
import { loadDeviceTokens } from "../services/device-pairing.js";

// ============================================================================
// CONSTANTS
// ============================================================================

const PORTS_TO_TRY = [3456, 3457, 3458, 3459, 3460];
const USER_CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Create the Hono app with all route groups mounted.
 *
 * @returns Configured Hono app instance
 */
function createApp(): Hono {
  const app = new Hono();

  // API route groups
  app.route("/api/claude-md", claudeMdRoutes());
  app.route("/api/conversations", conversationRoutes());
  app.route("/api/settings", settingsRoutes());
  app.route("/api/voice", voiceRoutes());
  app.route("/api/ngrok", ngrokRoutes());
  app.route("/api/twilio", twilioRoutes());
  app.route("/api/webrtc", webrtcRoutes());
  app.route("/api/mcp-servers", mcpServersRoutes());
  app.route("/api/auth", authRoutes());

  // Status endpoint (user CLAUDE.md conflict check)
  app.get("/api/status", async (c) => {
    let hasUserClaudeMd = false;
    try {
      await access(USER_CLAUDE_MD_PATH);
      hasUserClaudeMd = true;
    } catch {
      // File doesn't exist
    }
    return c.json({
      userClaudeMdExists: hasUserClaudeMd,
      userClaudeMdPath: USER_CLAUDE_MD_PATH,
    });
  });

  // Serve Vite build output
  app.get("*", serveStatic({ root: "./dashboard/dist" }));

  // SPA fallback: serve index.html for unmatched routes (client-side routing)
  app.get("*", (c) => {
    try {
      const html = readFileSync("./dashboard/dist/index.html", "utf-8");
      return c.html(html);
    } catch {
      return c.text("Dashboard not built. Run: npm run build:dashboard", 404);
    }
  });

  return app;
}

/**
 * Start the dashboard server.
 * Loads device tokens, then tries ports 3456-3460.
 *
 * @returns The port the server is listening on
 */
export async function startDashboard(): Promise<number> {
  await loadDeviceTokens();

  const app = createApp();

  for (const port of PORTS_TO_TRY) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = serve({ fetch: app.fetch, port }, () => {
          resolve();
        });
        server.on("error", reject);
      });

      setDashboardPort(port);
      console.log(`Dashboard running at http://localhost:${port}`);
      return port;
    } catch (err: unknown) {
      const error = err as { code?: string };
      if (error.code === "EADDRINUSE") {
        console.log(`Port ${port} in use, trying next...`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`All ports in use: ${PORTS_TO_TRY.join(", ")}`);
}
