/**
 * Current user route.
 *
 * - Returns the authenticated GitHub user from the signed gh_session cookie
 * - Returns { user: null } if not authenticated or signature is invalid
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-middleware";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns the currently authenticated GitHub user.
 * @param request - The incoming request with cookies
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getAuthenticatedUser(request);
  return NextResponse.json({ user: user ?? null });
}
