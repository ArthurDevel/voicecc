/**
 * API route for single agent operations.
 * - GET: returns agent metadata by ID
 * - DELETE: deletes agent (requires GitHub authentication)
 * - OPTIONS: CORS preflight
 */

import { NextRequest, NextResponse } from "next/server";
import { getAgent, deleteAgent } from "@/lib/s3";
import { getAuthenticatedUser } from "@/lib/auth-middleware";
import { withCors, handleOptions } from "@/lib/cors";

// ============================================================================
// TYPES
// ============================================================================

interface RouteParams {
  params: Promise<{ id: string }>;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Returns metadata for a single agent.
 * @param _request - incoming request (unused)
 * @param context - route params containing the agent ID
 * @returns JSON agent metadata
 */
export async function GET(
  _request: NextRequest,
  context: RouteParams
): Promise<Response> {
  try {
    const { id } = await context.params;
    const agent = await getAgent(id);
    return withCors(NextResponse.json(agent));
  } catch (err) {
    return withCors(
      NextResponse.json({ error: (err as Error).message }, { status: 400 })
    );
  }
}

/**
 * Deletes an agent from the marketplace.
 * Requires GitHub authentication. Only the author can delete their own agent.
 * @param request - incoming request with auth cookie
 * @param context - route params containing the agent ID
 * @returns JSON success response
 */
export async function DELETE(
  request: NextRequest,
  context: RouteParams
): Promise<Response> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user) {
      return withCors(
        NextResponse.json(
          { error: "Authentication required. Sign in with GitHub first." },
          { status: 401 }
        )
      );
    }

    const { id } = await context.params;

    // Verify the user owns this agent
    const agent = await getAgent(id);
    if (agent.author !== user.login) {
      return withCors(
        NextResponse.json(
          { error: "You can only delete your own agents." },
          { status: 403 }
        )
      );
    }

    await deleteAgent(id);
    return withCors(NextResponse.json({ success: true }));
  } catch (err) {
    return withCors(
      NextResponse.json({ error: (err as Error).message }, { status: 400 })
    );
  }
}

/**
 * Handles CORS preflight requests.
 */
export async function OPTIONS(): Promise<Response> {
  return handleOptions();
}
