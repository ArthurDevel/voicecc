/**
 * Version check API route.
 *
 * Compares the installed version against the latest on npm:
 * - GET / -- returns { current, latest, updateAvailable }
 * - Caches the npm lookup for 1 hour to avoid excessive requests
 */

import { Hono } from "hono";
import { readFileSync } from "fs";
import { join } from "path";

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const NPM_REGISTRY_URL = "https://registry.npmjs.org/voicecc/latest";

// ============================================================================
// CACHE
// ============================================================================

let cachedLatest: string | null = null;
let cachedAt = 0;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read the installed version from package.json.
 *
 * @returns Current version string (e.g. "1.0.11")
 */
function getCurrentVersion(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
  return pkg.version;
}

/**
 * Fetch the latest published version from the npm registry.
 * Returns cached value if within TTL.
 *
 * @returns Latest version string, or null if the fetch fails
 */
async function getLatestVersion(): Promise<string | null> {
  if (cachedLatest && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedLatest;
  }

  try {
    const res = await fetch(NPM_REGISTRY_URL);
    if (!res.ok) return cachedLatest;
    const data = (await res.json()) as { version: string };
    cachedLatest = data.version;
    cachedAt = Date.now();
    return cachedLatest;
  } catch {
    return cachedLatest;
  }
}

/**
 * Compare two semver strings (e.g. "1.0.11" vs "1.0.12").
 *
 * @param a - First version
 * @param b - Second version
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pb[i] > pa[i]) return -1;
  }
  return 0;
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for version checking.
 *
 * @returns Hono instance with GET / route
 */
export function versionRoutes(): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const current = getCurrentVersion();
    const latest = await getLatestVersion();
    const updateAvailable = latest !== null && semverCompare(current, latest) < 0;

    return c.json({ current, latest, updateAvailable });
  });

  return app;
}
