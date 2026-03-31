/**
 * Authentication middleware helper.
 *
 * Extracts the authenticated GitHub user from a signed HttpOnly cookie.
 * No GitHub API call needed -- the server trusts the cookie it signed.
 *
 * - Reads the gh_session cookie from the request
 * - Verifies the HMAC signature
 * - Returns the user info or null if unauthenticated/tampered
 */

import { type GitHubUser } from "./github-auth";
import { verifyValue } from "./cookie-sign";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Extracts the authenticated GitHub user from the signed session cookie.
 * @param request - The incoming request object
 * @returns The GitHub user if authenticated, or null otherwise
 */
export async function getAuthenticatedUser(
  request: Request
): Promise<GitHubUser | null> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  const signed = parseCookieValue(cookieHeader, "gh_session");
  if (!signed) return null;

  const payload = verifyValue(signed);
  if (!payload) return null;

  try {
    return JSON.parse(payload) as GitHubUser;
  } catch {
    return null;
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parses a specific cookie value from a cookie header string.
 * @param cookieHeader - The raw Cookie header value
 * @param name - The cookie name to look for
 * @returns The cookie value or null if not found
 */
function parseCookieValue(cookieHeader: string, name: string): string | null {
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));

  if (!match) return null;

  return match.substring(name.length + 1);
}
