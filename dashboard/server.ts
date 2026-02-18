/**
 * Dashboard HTTP server for the Claude Code voice sidecar.
 *
 * Serves a browser-based file editor on a local port. Runs independently
 * of the voice pipeline -- no shared state.
 *
 * Responsibilities:
 * - Serve static files from dashboard/public/
 * - Expose REST API for reading, writing, and listing files on disk
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, writeFile, readdir, stat } from "fs/promises";
import { join, extname, resolve } from "path";
import { fileURLToPath } from "url";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PORT = 3456;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

/**
 * Start the dashboard HTTP server.
 *
 * @param port - Port to listen on (default 3456)
 * @returns Resolves when the server is listening
 */
export function startDashboard(port: number = DEFAULT_PORT): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer(handleRequest);
    server.on("error", reject);
    server.listen(port, () => {
      console.log(`Dashboard running at http://localhost:${port}`);
      resolve();
    });
  });
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Route incoming HTTP requests to the appropriate handler.
 *
 * @param req - Incoming HTTP request
 * @param res - Server response
 */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (pathname === "/api/files/list" && req.method === "GET") {
      await handleFileList(url, res);
    } else if (pathname === "/api/files/read" && req.method === "GET") {
      await handleFileRead(url, res);
    } else if (pathname === "/api/files/write" && req.method === "POST") {
      await handleFileWrite(req, res);
    } else {
      await handleStaticFile(pathname, res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(res, 500, { error: message });
  }
}

/**
 * List directory contents.
 * GET /api/files/list?path=/absolute/path
 *
 * @param url - Parsed request URL with query params
 * @param res - Server response
 */
async function handleFileList(url: URL, res: ServerResponse): Promise<void> {
  const dirPath = url.searchParams.get("path");
  if (!dirPath) {
    sendJson(res, 400, { error: "Missing 'path' query parameter" });
    return;
  }

  const resolved = resolve(dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });

  const items = entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
  }));

  // Sort: directories first, then alphabetical
  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  sendJson(res, 200, { path: resolved, items });
}

/**
 * Read a file's contents.
 * GET /api/files/read?path=/absolute/path/to/file
 *
 * @param url - Parsed request URL with query params
 * @param res - Server response
 */
async function handleFileRead(url: URL, res: ServerResponse): Promise<void> {
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    sendJson(res, 400, { error: "Missing 'path' query parameter" });
    return;
  }

  const resolved = resolve(filePath);
  const content = await readFile(resolved, "utf-8");
  sendJson(res, 200, { path: resolved, content });
}

/**
 * Write content to a file.
 * POST /api/files/write
 * Body: { "path": "/absolute/path", "content": "file contents" }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response
 */
async function handleFileWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { path: filePath, content } = JSON.parse(body);

  if (!filePath || content === undefined) {
    sendJson(res, 400, { error: "Missing 'path' or 'content' in request body" });
    return;
  }

  const resolved = resolve(filePath);
  await writeFile(resolved, content, "utf-8");
  sendJson(res, 200, { path: resolved, success: true });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Serve a static file from the public directory.
 * Falls back to index.html for the root path.
 *
 * @param pathname - URL pathname (e.g. "/index.html")
 * @param res - Server response
 */
async function handleStaticFile(pathname: string, res: ServerResponse): Promise<void> {
  const filePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const fullPath = join(PUBLIC_DIR, filePath);

  try {
    const content = await readFile(fullPath);
    const ext = extname(fullPath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

/**
 * Read the full request body as a string.
 *
 * @param req - Incoming HTTP request
 * @returns The request body as a UTF-8 string
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Send a JSON response.
 *
 * @param res - Server response
 * @param status - HTTP status code
 * @param data - JSON-serializable data
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
