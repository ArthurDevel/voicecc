/**
 * Unified HTTP + WebSocket voice server.
 *
 * Runs on TWILIO_PORT (default 8080) and handles both Twilio and browser
 * audio connections on the same port. All other HTTP requests are proxied
 * to the dashboard server.
 *
 * Routes:
 * - POST /twilio/incoming-call → Twilio webhook handler
 * - POST /register-call        → outbound call token registration
 * - WS   /media/:token         → Twilio media stream
 * - WS   /audio?token=<token>  → Browser audio stream
 * - *                           → proxy to dashboard
 */

import "dotenv/config";

import { createServer, request as httpRequest } from "http";
import { WebSocketServer } from "ws";

import { handleTwilioHttpRequest, handleTwilioUpgrade } from "./twilio-server.js";
import { handleBrowserUpgrade } from "./browser-server.js";

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PORT = 8080;

/** Ping interval to keep WebSocket connections alive through tunnel (ms) */
const PING_INTERVAL_MS = 30_000;

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the unified voice server.
 *
 * Creates an HTTP server that routes Twilio webhooks and browser/Twilio
 * WebSocket upgrades, proxying everything else to the dashboard.
 *
 * @param dashboardPort - Dashboard server port for proxying
 * @returns Resolves when the server is listening
 */
export async function startVoiceServer(dashboardPort: number): Promise<number> {
  const port = parseInt(process.env.TWILIO_PORT ?? "", 10) || DEFAULT_PORT;

  const server = createServer((req, res) => {
    // Try Twilio HTTP handlers first
    if (handleTwilioHttpRequest(req, res)) {
      return;
    }

    // Proxy everything else to the dashboard
    proxyToDashboard(req, res, dashboardPort);
  });

  const wss = new WebSocketServer({ noServer: true });

  // Route WebSocket upgrades by path
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/media/")) {
      handleTwilioUpgrade(req, socket, head, wss);
    } else if (url.pathname === "/audio") {
      handleBrowserUpgrade(req, socket, head, wss);
    } else {
      socket.destroy();
    }
  });

  // Periodic ping to keep connections alive through tunnel
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    });
  }, PING_INTERVAL_MS);

  return new Promise<number>((resolve) => {
    server.listen(port, () => {
      console.log(`Voice server listening on port ${port}`);
      resolve(port);
    });
  });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Proxy an HTTP request to the dashboard server on localhost.
 *
 * @param req - Original incoming request
 * @param res - Response to write the proxied result to
 * @param dashboardPort - Port the dashboard server is listening on
 */
function proxyToDashboard(req: IncomingMessage, res: ServerResponse, dashboardPort: number): void {
  const proxyReq = httpRequest(
    {
      hostname: "127.0.0.1",
      port: dashboardPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, "x-forwarded-for": "127.0.0.1" },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Dashboard unavailable");
  });

  req.pipe(proxyReq);
}
