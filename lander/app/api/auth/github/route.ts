/**
 * GitHub OAuth login route.
 *
 * - Redirects the user to GitHub's OAuth authorization page
 */

import { NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/github-auth";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/** Redirects to GitHub OAuth authorization URL. */
export async function GET(): Promise<NextResponse> {
  const url = getAuthUrl();
  return NextResponse.redirect(url);
}
