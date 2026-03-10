/**
 * API route for listing all marketplace agents.
 * - GET: returns array of MarketplaceAgentMeta
 * - OPTIONS: CORS preflight
 */

import { NextResponse } from "next/server";
import { listAgents } from "@/lib/s3";
import { withCors, handleOptions } from "@/lib/cors";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Lists all agents in the marketplace.
 * @returns JSON array of agent metadata
 */
export async function GET(): Promise<Response> {
  try {
    const agents = await listAgents();
    return withCors(NextResponse.json(agents));
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
