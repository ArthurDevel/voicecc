/**
 * Shared fetch helpers for all API calls.
 *
 * Provides typed get/post wrappers that throw ApiError on non-2xx responses.
 */

// ============================================================================
// TYPES
// ============================================================================

/** Error thrown on non-2xx API responses */
export interface ApiError {
  status: number;
  message: string;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Send a GET request to the API.
 *
 * @param path - API path (e.g. "/api/settings")
 * @returns Parsed JSON response
 */
export async function get<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Request failed" }));
    throw { status: res.status, message: data.error || "Request failed" } as ApiError;
  }
  return res.json();
}

/**
 * Send a POST request to the API with an optional JSON body.
 *
 * @param path - API path (e.g. "/api/settings")
 * @param body - Optional JSON-serializable body
 * @returns Parsed JSON response
 */
export async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Request failed" }));
    throw { status: res.status, message: data.error || "Request failed" } as ApiError;
  }
  return res.json();
}
