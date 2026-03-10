/**
 * S3 client for the agent marketplace.
 *
 * Uses a SeaweedFS instance with S3-compatible API. Stores agent zips at
 * `<id>.zip` and metadata at `<id>.json` in the configured bucket.
 *
 * - Publish agents (export, strip MEMORY.md, upload zip + metadata to S3)
 * - List all published agents (prefix scan with 60s cache)
 * - Download agent zip from S3
 * - Get single agent metadata from S3
 * - Delete agent from S3 (zip + metadata)
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { execFile } from "child_process";
import { promisify } from "util";

import { exportAgent } from "./agent-store.js";

const execFileAsync = promisify(execFile);

// ============================================================================
// CONSTANTS
// ============================================================================

const CACHE_TTL_MS = 60_000;

// ============================================================================
// TYPES
// ============================================================================

/** Metadata stored alongside each published agent zip in S3 */
export interface MarketplaceAgentMeta {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  publishedAt: string;
  size: number;
}

/** Parameters required to publish a local agent to the marketplace */
export interface PublishAgentParams {
  agentId: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
}

// ============================================================================
// MODULE-LEVEL STATE
// ============================================================================

let s3Client: S3Client | null = null;

let listCache: { data: MarketplaceAgentMeta[]; expiresAt: number } | null = null;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Publish a local agent to the marketplace.
 *
 * Exports the agent as a zip, strips MEMORY.md (privacy), uploads the zip
 * and a JSON metadata file to S3. Overwrites if the same ID already exists.
 *
 * @param params - Agent details and metadata for publishing
 * @returns The metadata object written to S3
 */
export async function publishAgent(params: PublishAgentParams): Promise<MarketplaceAgentMeta> {
  const { agentId, name, description, author, version, tags } = params;

  const client = getS3Client();
  const bucket = requireEnv("S3_BUCKET");
  const marketplaceId = toMarketplaceId(author, agentId);

  // Export the agent as a zip buffer
  const rawZip = await exportAgent(agentId);

  // Strip MEMORY.md from the zip for privacy
  const cleanZip = await stripMemoryMd(rawZip);

  // Upload zip to S3
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${marketplaceId}.zip`,
      Body: cleanZip,
      ContentType: "application/zip",
    }),
  );

  // Build and upload metadata
  const meta: MarketplaceAgentMeta = {
    id: marketplaceId,
    name,
    description,
    author,
    version,
    tags,
    publishedAt: new Date().toISOString(),
    size: cleanZip.length,
  };

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${marketplaceId}.json`,
      Body: JSON.stringify(meta, null, 2),
      ContentType: "application/json",
    }),
  );

  // Invalidate list cache
  listCache = null;

  return meta;
}

/**
 * List all published agents by scanning the S3 bucket for *.json files.
 *
 * Results are cached in memory for 60 seconds to avoid excessive S3 calls.
 *
 * @returns Array of all published agent metadata
 */
export async function listMarketplaceAgents(): Promise<MarketplaceAgentMeta[]> {
  // Return cached data if still valid
  if (listCache && Date.now() < listCache.expiresAt) {
    return listCache.data;
  }

  const client = getS3Client();
  const bucket = requireEnv("S3_BUCKET");

  // List all objects and filter to .json metadata files
  const response = await client.send(
    new ListObjectsV2Command({ Bucket: bucket }),
  );

  const jsonKeys = (response.Contents ?? [])
    .map((obj) => obj.Key!)
    .filter((key) => key.endsWith(".json"));

  // Fetch and parse each metadata file
  const agents: MarketplaceAgentMeta[] = [];
  for (const key of jsonKeys) {
    const obj = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await obj.Body!.transformToString();
    agents.push(JSON.parse(body) as MarketplaceAgentMeta);
  }

  // Cache the results
  listCache = { data: agents, expiresAt: Date.now() + CACHE_TTL_MS };

  return agents;
}

/**
 * Download an agent zip from S3.
 *
 * @param id - Marketplace agent ID
 * @returns Buffer containing the zip archive
 */
export async function downloadAgent(id: string): Promise<Buffer> {
  const client = getS3Client();
  const bucket = requireEnv("S3_BUCKET");

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${id}.zip` }),
  );

  const bytes = await response.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Fetch metadata for a single marketplace agent.
 *
 * @param id - Marketplace agent ID
 * @returns Parsed metadata object
 */
export async function getMarketplaceAgent(id: string): Promise<MarketplaceAgentMeta> {
  const client = getS3Client();
  const bucket = requireEnv("S3_BUCKET");

  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: `${id}.json` }),
  );

  const body = await response.Body!.transformToString();
  return JSON.parse(body) as MarketplaceAgentMeta;
}

/**
 * Delete an agent from the marketplace by removing both its zip and metadata.
 *
 * @param id - Marketplace agent ID
 */
export async function deleteMarketplaceAgent(id: string): Promise<void> {
  const client = getS3Client();
  const bucket = requireEnv("S3_BUCKET");

  await Promise.all([
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${id}.zip` })),
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${id}.json` })),
  ]);

  // Invalidate list cache
  listCache = null;
}

/**
 * Get or create the module-level S3 client singleton.
 *
 * Configured with forcePathStyle for SeaweedFS compatibility. Reads connection
 * details from S3_* environment variables.
 *
 * @returns Configured S3Client instance
 */
export function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  const endpoint = requireEnv("S3_ENDPOINT");
  const region = requireEnv("S3_REGION");
  const accessKeyId = requireEnv("S3_ACCESS_KEY");
  const secretAccessKey = requireEnv("S3_SECRET_KEY");

  s3Client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return s3Client;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Read a required environment variable, throwing if it is not set.
 *
 * @param name - Environment variable name
 * @returns The environment variable value
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Generate a marketplace ID from author and agent ID.
 *
 * Format: "<author>-<agentId>", lowercased, spaces replaced with hyphens.
 *
 * @param author - Publisher name
 * @param agentId - Local agent identifier
 * @returns Normalized marketplace ID
 */
function toMarketplaceId(author: string, agentId: string): string {
  return `${author}-${agentId}`.toLowerCase().replace(/\s+/g, "-");
}

/**
 * Strip MEMORY.md from a zip buffer by extracting to a temp directory,
 * overwriting MEMORY.md with an empty string, and re-zipping.
 *
 * @param zipBuffer - Original zip buffer containing agent files
 * @returns New zip buffer with MEMORY.md contents cleared
 */
async function stripMemoryMd(zipBuffer: Buffer): Promise<Buffer> {
  const tempDir = join(tmpdir(), `marketplace-strip-${Date.now()}`);
  const inputZipPath = join(tmpdir(), `marketplace-input-${Date.now()}.zip`);
  const outputZipPath = join(tmpdir(), `marketplace-output-${Date.now()}.zip`);

  try {
    // Extract the original zip to a temp directory
    await writeFile(inputZipPath, zipBuffer);
    await mkdir(tempDir, { recursive: true });
    await execFileAsync("unzip", ["-o", inputZipPath, "-d", tempDir]);

    // Overwrite MEMORY.md with empty content
    await writeFile(join(tempDir, "MEMORY.md"), "", "utf-8");

    // Re-zip the directory
    await execFileAsync("zip", ["-r", outputZipPath, "."], { cwd: tempDir });

    return await readFile(outputZipPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await rm(inputZipPath, { force: true }).catch(() => {});
    await rm(outputZipPath, { force: true }).catch(() => {});
  }
}
