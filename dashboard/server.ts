/**
 * Dashboard HTTP server -- CLAUDE.md editor.
 *
 * Serves a single-page editor for the project-level CLAUDE.md file.
 *
 * Responsibilities:
 * - Serve the editor UI from dashboard/public/
 * - Expose REST API to read and write CLAUDE.md
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { readFile, writeFile, access } from "fs/promises";
import { join, extname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

// ============================================================================
// CONSTANTS
// ============================================================================

const DEFAULT_PORT = 3456;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const CLAUDE_MD_PATH = join(process.cwd(), "CLAUDE.md");
const USER_CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
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
  return new Promise((resolvePromise, reject) => {
    const server = createServer(handleRequest);
    server.on("error", reject);
    server.listen(port, () => {
      console.log(`CLAUDE.md editor running at http://localhost:${port}`);
      resolvePromise();
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
    if (pathname === "/api/status" && req.method === "GET") {
      await handleStatus(res);
    } else if (pathname === "/api/claude-md" && req.method === "GET") {
      await handleRead(res);
    } else if (pathname === "/api/claude-md" && req.method === "POST") {
      await handleWrite(req, res);
    } else {
      await handleStaticFile(pathname, res);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal server error";
    sendJson(res, 500, { error: message });
  }
}

/**
 * Check for potential conflicts (e.g. user-level CLAUDE.md).
 * GET /api/status
 *
 * @param res - Server response
 */
async function handleStatus(res: ServerResponse): Promise<void> {
  const hasUserClaudeMd = await fileExists(USER_CLAUDE_MD_PATH);
  sendJson(res, 200, {
    userClaudeMdExists: hasUserClaudeMd,
    userClaudeMdPath: USER_CLAUDE_MD_PATH,
  });
}

/**
 * Read the CLAUDE.md file.
 * GET /api/claude-md
 *
 * @param res - Server response
 */
async function handleRead(res: ServerResponse): Promise<void> {
  const content = await readFile(CLAUDE_MD_PATH, "utf-8");
  sendJson(res, 200, { content });
}

/**
 * Write the CLAUDE.md file.
 * POST /api/claude-md
 * Body: { "content": "file contents" }
 *
 * @param req - Incoming HTTP request with JSON body
 * @param res - Server response
 */
async function handleWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { content } = JSON.parse(body);

  if (content === undefined) {
    sendJson(res, 400, { error: "Missing 'content' in request body" });
    return;
  }

  await writeFile(CLAUDE_MD_PATH, content, "utf-8");
  sendJson(res, 200, { success: true });
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a file exists on disk.
 *
 * @param path - Absolute file path
 * @returns True if the file exists
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serve a static file from the public directory.
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
