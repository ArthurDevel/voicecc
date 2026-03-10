/**
 * GitHub OAuth callback route.
 *
 * Handles the redirect from GitHub after user authorization:
 * - Exchanges the authorization code for an access token
 * - Fetches the user's GitHub profile
 * - Sets a signed gh_session cookie with user info (no token stored)
 * - Sets a plain gh_user cookie for client-side reading
 * - Redirects to /marketplace
 */

import { NextRequest, NextResponse } from "next/server";
import { exchangeCode, getGitHubUser } from "@/lib/github-auth";
import { signValue } from "@/lib/cookie-sign";

// ============================================================================
// CONSTANTS
// ============================================================================

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days in seconds

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Handles the GitHub OAuth callback.
 * Exchanges the code for a token, fetches user info, then stores
 * only the user info in a signed HttpOnly cookie. The token is not persisted.
 * @param request - The incoming request with the authorization code
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json(
      { error: "Missing code parameter" },
      { status: 400 }
    );
  }

  // Exchange code for access token (used only here, not stored)
  const accessToken = await exchangeCode(code);

  // Fetch user profile
  const user = await getGitHubUser(accessToken);

  // Build redirect response
  const redirectUrl = new URL("/marketplace", request.nextUrl.origin);
  const response = NextResponse.redirect(redirectUrl);

  // Signed HttpOnly cookie with user info (server-side verification)
  const userPayload = JSON.stringify({
    login: user.login,
    avatar_url: user.avatar_url,
    name: user.name,
  });
  response.cookies.set("gh_session", signValue(userPayload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  // Plain cookie for client-side display (not trusted by server)
  response.cookies.set("gh_user", userPayload, {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return response;
}
