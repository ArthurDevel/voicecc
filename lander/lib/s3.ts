/**
 * S3 service layer for agent marketplace operations.
 * Uses SeaweedFS as S3-compatible backend.
 *
 * - Manages agent zip files and metadata in S3
 * - Provides CRUD operations for marketplace agents
 * - Caches agent listings with 60s TTL
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

export interface MarketplaceAgentMeta {
  /** Unique marketplace ID (format: "<githubUsername>-<name>") */
  id: string;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** GitHub username (from OAuth) */
  author: string;
  /** GitHub avatar URL */
  authorAvatarUrl: string;
  /** Semver string */
  version: string;
  /** Searchable tags */
  tags: string[];
  /** ISO 8601 timestamp */
  publishedAt: string;
  /** Zip file size in bytes */
  size: number;
}

export interface PublishAgentParams {
  /** The agent zip file */
  zipBuffer: Buffer;
  /** Display name */
  name: string;
  /** Short description */
  description: string;
  /** GitHub username */
  author: string;
  /** GitHub avatar URL */
  authorAvatarUrl: string;
  /** Semver string */
  version: string;
  /** Searchable tags */
  tags: string[];
}

// ============================================================================
// MAIN HANDLERS
// ============================================================================

let s3Client: S3Client | null = null;

/**
 * Returns a lazy singleton S3 client configured for SeaweedFS.
 * @returns configured S3Client instance
 */
export function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  const endpoint = process.env.S3_ENDPOINT;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;

  if (!endpoint) throw new Error("S3_ENDPOINT env var is required");
  if (!region) throw new Error("S3_REGION env var is required");
  if (!accessKeyId) throw new Error("S3_ACCESS_KEY env var is required");
  if (!secretAccessKey) throw new Error("S3_SECRET_KEY env var is required");

  s3Client = new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  return s3Client;
}

/**
 * Lists all agents in the marketplace.
 * Uses a module-level cache with 60s TTL.
 * @returns array of agent metadata
 */
export async function listAgents(): Promise<MarketplaceAgentMeta[]> {
  // Check cache
  if (agentCache && Date.now() - agentCacheTimestamp < CACHE_TTL_MS) {
    return agentCache;
  }

  const client = getS3Client();
  const bucket = getBucket();

  // List all .json metadata files
  const listResult = await client.send(
    new ListObjectsV2Command({ Bucket: bucket })
  );

  const jsonKeys = (listResult.Contents ?? [])
    .map((obj) => obj.Key)
    .filter((key): key is string => key != null && key.endsWith(".json"));

  // Fetch each metadata file
  const agents: MarketplaceAgentMeta[] = [];
  for (const key of jsonKeys) {
    const getResult = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    const body = await getResult.Body?.transformToString();
    if (body) {
      agents.push(JSON.parse(body) as MarketplaceAgentMeta);
    }
  }

  // Update cache
  agentCache = agents;
  agentCacheTimestamp = Date.now();

  return agents;
}

/**
 * Publishes an agent to the marketplace.
 * Uploads the zip file and writes metadata JSON. Overwrites if same ID exists.
 * @param params - publish parameters including zip buffer and metadata
 * @returns the created/updated agent metadata
 */
export async function publishAgent(
  params: PublishAgentParams
): Promise<MarketplaceAgentMeta> {
  const { zipBuffer, name, description, author, authorAvatarUrl, version, tags } = params;

  const id = buildAgentId(author, name);
  const client = getS3Client();
  const bucket = getBucket();

  // Upload zip file
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${id}.zip`,
      Body: zipBuffer,
      ContentType: "application/zip",
    })
  );

  // Build metadata
  const meta: MarketplaceAgentMeta = {
    id,
    name,
    description,
    author,
    authorAvatarUrl,
    version,
    tags,
    publishedAt: new Date().toISOString(),
    size: zipBuffer.length,
  };

  // Upload metadata JSON
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${id}.json`,
      Body: JSON.stringify(meta),
      ContentType: "application/json",
    })
  );

  invalidateCache();
  return meta;
}

/**
 * Downloads an agent zip file from S3.
 * @param id - the agent marketplace ID
 * @returns the zip file as a Buffer
 */
export async function downloadAgent(id: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = getBucket();

  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${id}.zip` })
  );

  const bytes = await result.Body?.transformToByteArray();
  if (!bytes) throw new Error(`Agent zip not found: ${id}`);

  return Buffer.from(bytes);
}

/**
 * Fetches metadata for a single agent.
 * @param id - the agent marketplace ID
 * @returns the agent metadata
 */
export async function getAgent(id: string): Promise<MarketplaceAgentMeta> {
  const client = getS3Client();
  const bucket = getBucket();

  const result = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${id}.json` })
  );

  const body = await result.Body?.transformToString();
  if (!body) throw new Error(`Agent not found: ${id}`);

  return JSON.parse(body) as MarketplaceAgentMeta;
}

/**
 * Deletes an agent (both zip and metadata) from S3.
 * @param id - the agent marketplace ID
 */
export async function deleteAgent(id: string): Promise<void> {
  const client = getS3Client();
  const bucket = getBucket();

  await Promise.all([
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${id}.zip` })),
    client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: `${id}.json` })
    ),
  ]);

  invalidateCache();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

let agentCache: MarketplaceAgentMeta[] | null = null;
let agentCacheTimestamp = 0;

/**
 * Invalidates the agent listing cache.
 */
function invalidateCache(): void {
  agentCache = null;
  agentCacheTimestamp = 0;
}

/**
 * Returns the S3 bucket name from env vars.
 * @returns bucket name
 */
function getBucket(): string {
  const bucket = process.env.S3_BUCKET;
  if (!bucket) throw new Error("S3_BUCKET env var is required");
  return bucket;
}

/**
 * Builds a marketplace agent ID from author and name.
 * Format: "<author>-<name>" lowercased, spaces replaced with hyphens.
 * @param author - GitHub username
 * @param name - agent display name
 * @returns the agent ID string
 */
function buildAgentId(author: string, name: string): string {
  return `${author}-${name}`.toLowerCase().replace(/\s+/g, "-");
}
