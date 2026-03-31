/**
 * Logout route.
 *
 * - Clears the gh_session and gh_user cookies
 * - Returns a success response
 */

import { NextResponse } from "next/server";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/** Clears authentication cookies and returns success. */
export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ success: true });

  response.cookies.set("gh_session", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  response.cookies.set("gh_user", "", {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
