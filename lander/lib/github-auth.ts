/**
 * GitHub OAuth helper functions.
 *
 * Handles the GitHub OAuth flow using plain fetch calls:
 * - Generates the authorization URL for redirecting users to GitHub
 * - Exchanges authorization codes for access tokens
 * - Fetches authenticated user profile information
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

// ============================================================================
// TYPES
// ============================================================================

/** GitHub user profile returned from the API. */
interface GitHubUser {
  /** GitHub username */
  login: string;
  /** Profile picture URL */
  avatar_url: string;
  /** Display name (may be null if not set) */
  name: string | null;
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Builds the GitHub OAuth authorization URL.
 * @returns The full URL to redirect the user to for GitHub login
 */
function getAuthUrl(): string {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error("GITHUB_CLIENT_ID environment variable is not set");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    scope: "read:user",
  });

  return `${GITHUB_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchanges an authorization code for a GitHub access token.
 * @param code - The authorization code received from GitHub's OAuth callback
 * @returns The access token string
 */
async function exchangeCode(code: string): Promise<string> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set"
    );
  }

  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error_description || data.error}`);
  }

  return data.access_token as string;
}

/**
 * Fetches the authenticated user's GitHub profile.
 * @param accessToken - A valid GitHub access token
 * @returns The user's profile information
 */
async function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  const data = await response.json();

  return {
    login: data.login,
    avatar_url: data.avatar_url,
    name: data.name,
  };
}

export { getAuthUrl, exchangeCode, getGitHubUser };
export type { GitHubUser };
