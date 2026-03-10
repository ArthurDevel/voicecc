/**
 * API route for uploading/publishing an agent to the marketplace.
 * - POST: accepts multipart/form-data with zip file and metadata
 * - OPTIONS: CORS preflight
 */

import { NextRequest, NextResponse } from "next/server";
import { publishAgent } from "@/lib/s3";
import { getAuthenticatedUser } from "@/lib/auth-middleware";
import { withCors, handleOptions } from "@/lib/cors";

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Uploads and publishes an agent to the marketplace.
 * Expects multipart/form-data with fields: file, name, description, version, tags.
 * Author is determined from the authenticated GitHub user.
 * @param request - incoming request with form data and auth cookie
 * @returns JSON with success flag and agent metadata
 */
export async function POST(request: NextRequest): Promise<Response> {
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
    const author = user.login;

    const formData = await request.formData();

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return withCors(
        NextResponse.json(
          { error: "file field is required and must be a file" },
          { status: 400 }
        )
      );
    }

    const name = formData.get("name") as string | null;
    if (!name) {
      return withCors(
        NextResponse.json({ error: "name field is required" }, { status: 400 })
      );
    }

    const description = (formData.get("description") as string) ?? "";
    const version = (formData.get("version") as string) ?? "1.0.0";
    const tagsRaw = (formData.get("tags") as string) ?? "";
    const tags = tagsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // Convert file to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);

    const agent = await publishAgent({
      zipBuffer,
      name,
      description,
      author,
      authorAvatarUrl: user.avatar_url,
      version,
      tags,
    });

    return withCors(NextResponse.json({ success: true, agent }));
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
