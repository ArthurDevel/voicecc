/**
 * Environment file (.env) read/write service.
 *
 * Shared utility for all services that need to read or write .env configuration:
 * - Parse raw .env content into key-value records
 * - Read .env from disk with a configurable path
 * - Write a single key or full record back to disk
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

/** Default .env path: ~/.voicecc/.env (survives npm install -g updates) */
const DEFAULT_ENV_PATH = process.env.VOICECC_DIR
  ? join(process.env.VOICECC_DIR, ".env")
  : join(homedir(), ".voicecc", ".env");

// ============================================================================
// TYPES
// ============================================================================

/** Key-value record representing parsed .env contents */
export type EnvRecord = Record<string, string>;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Read and parse a .env file from disk.
 * Returns an empty record if the file does not exist.
 *
 * @param envPath - Absolute path to the .env file. Defaults to ~/.voicecc/.env
 * @returns Parsed key-value pairs from the .env file
 */
export async function readEnv(envPath?: string): Promise<EnvRecord> {
  const filePath = envPath ?? DEFAULT_ENV_PATH;
  const content = await readFile(filePath, "utf-8").catch(() => "");
  return parseEnvFile(content);
}

/**
 * Update a single key in the .env file, preserving all other values.
 * Creates the file if it does not exist.
 *
 * @param key - The env variable name to set
 * @param value - The value to write
 * @param envPath - Absolute path to the .env file. Defaults to ~/.voicecc/.env
 */
export async function writeEnvKey(key: string, value: string, envPath?: string): Promise<void> {
  const settings = await readEnv(envPath);
  settings[key] = value;
  await writeEnvFile(settings, envPath);
}

/**
 * Write a full key-value record to a .env file.
 * Overwrites the entire file contents. Each entry becomes a KEY=VALUE line.
 *
 * @param settings - Key-value pairs to write
 * @param envPath - Absolute path to the .env file. Defaults to ~/.voicecc/.env
 */
export async function writeEnvFile(settings: EnvRecord, envPath?: string): Promise<void> {
  const filePath = envPath ?? DEFAULT_ENV_PATH;
  const lines = Object.entries(settings).map(([k, v]) => `${k}=${v}`);
  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse a .env file string into a key-value record.
 * Handles lines in the format KEY=VALUE, ignores empty lines and comments.
 * Keeps empty values (KEY= produces { KEY: "" }). Does NOT strip quotes.
 *
 * @param content - Raw .env file content
 * @returns Parsed key-value pairs
 */
export function parseEnvFile(content: string): EnvRecord {
  const result: EnvRecord = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}
