/**
 * CORS utility for API routes.
 * - Adds CORS headers to responses
 * - Provides OPTIONS handler for preflight requests
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Username",
};

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Adds CORS headers to an existing Response.
 * @param response - the Response object to add headers to
 * @returns the same Response with CORS headers added
 */
export function withCors(response: Response): Response {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/**
 * Returns a 204 response for CORS preflight requests.
 * @returns Response with CORS headers and no body
 */
export function handleOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
