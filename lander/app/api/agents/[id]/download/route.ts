/**
 * API route for downloading an agent zip file.
 * - GET: returns binary zip with appropriate headers
 * - OPTIONS: CORS preflight
 */

import { NextRequest, NextResponse } from "next/server";
import { downloadAgent } from "@/lib/s3";
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
 * Downloads an agent zip file.
 * @param _request - incoming request (unused)
 * @param context - route params containing the agent ID
 * @returns binary zip response with Content-Disposition header
 */
export async function GET(
  _request: NextRequest,
  context: RouteParams
): Promise<Response> {
  try {
    const { id } = await context.params;
    const buffer = await downloadAgent(id);

    return withCors(
      new NextResponse(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${id}.zip"`,
        },
      })
    );
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
