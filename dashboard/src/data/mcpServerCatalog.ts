/**
 * Catalog of preloaded MCP server presets.
 *
 * Each entry represents an HTTP MCP server that can be added with one click
 * (no env vars required -- OAuth handled by the CLI).
 *
 * - Used by AddMcpServerModal to render available servers
 * - URL is the canonical identifier for detecting already-installed servers
 */

// ============================================================================
// TYPES
// ============================================================================

export interface McpServerPreset {
  /** Default name passed to `claude mcp add` */
  name: string;
  /** Short description shown on the card */
  description: string;
  /** Canonical MCP endpoint URL */
  url: string;
  /** Transport type for `claude mcp add --transport` */
  transport: "http" | "sse";
}

// ============================================================================
// CATALOG
// ============================================================================

export const MCP_SERVER_CATALOG: McpServerPreset[] = [
  {
    name: "notion",
    description: "Connect to Notion workspaces, pages, and databases.",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
  },
  {
    name: "figma",
    description: "Read Figma designs, components, and design tokens.",
    url: "https://mcp.figma.com/mcp",
    transport: "http",
  },
  {
    name: "sentry",
    description: "Access Sentry issues, events, and project data.",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
  },
  {
    name: "context7",
    description: "Fetch up-to-date library docs and code examples.",
    url: "https://mcp.context7.com/mcp",
    transport: "http",
  },
  {
    name: "langfuse",
    description: "Search Langfuse documentation and API references.",
    url: "https://langfuse.com/api/mcp",
    transport: "http",
  },
  {
    name: "slack",
    description: "Send messages, create canvases, and fetch Slack data.",
    url: "https://mcp.slack.com/mcp",
    transport: "http",
  },
  {
    name: "atlassian",
    description: "Access Jira & Confluence from Claude.",
    url: "https://mcp.atlassian.com/v1/mcp",
    transport: "http",
  },
  {
    name: "linear",
    description: "Manage issues, projects & team workflows in Linear.",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
  },
  {
    name: "gamma",
    description: "Create presentations, docs, socials, and sites with AI.",
    url: "https://mcp.gamma.app/mcp",
    transport: "http",
  },
  {
    name: "granola",
    description: "The AI notepad for meetings.",
    url: "https://mcp.granola.ai/mcp",
    transport: "http",
  },
];
