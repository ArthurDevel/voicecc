/**
 * Tests for provider listing and validation routes.
 *
 * Validates that:
 * - GET /tts and /stt return both providers with correct status
 * - Active provider reflects TTS_PROVIDER / STT_PROVIDER from .env
 * - Deepgram validation endpoint returns correct status
 * - Deepgram voices endpoint returns hardcoded voice list
 * - ElevenLabs voices endpoint returns empty array when no API key
 *
 * Run: npx tsx --test dashboard/routes/providers.test.ts
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { writeFile, mkdir, rm, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ============================================================================
// HELPERS
// ============================================================================

/**
 * The env module resolves DEFAULT_ENV_PATH at load time using VOICECC_DIR or
 * ~/.voicecc/.env. Tests write directly to that resolved path, backing up and
 * restoring the original .env around each test.
 */
const ENV_DIR = process.env.VOICECC_DIR ?? join(homedir(), ".voicecc");
const ENV_PATH = join(ENV_DIR, ".env");
const ENV_BACKUP = ENV_PATH + ".test-backup";

const originalFetch = globalThis.fetch;

// Dynamic import so we can lazy-load after env setup if needed
let providersRoutes: typeof import("./providers.js")["providersRoutes"];

/**
 * Write a .env file with the given key-value pairs (overwrites).
 *
 * @param entries - key-value pairs to write
 */
async function writeTestEnv(entries: Record<string, string>): Promise<void> {
  await mkdir(ENV_DIR, { recursive: true });
  const lines = Object.entries(entries).map(([k, v]) => `${k}=${v}`);
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf-8");
}

/**
 * Send a GET request to the given path on the providers router.
 *
 * @param path - route path (e.g. "/tts")
 * @returns parsed JSON response
 */
async function getJson(path: string): Promise<Record<string, unknown>> {
  const app = providersRoutes();
  const req = new Request(`http://localhost${path}`);
  const res = await app.request(req);
  assert.equal(res.status, 200, `Expected 200 for ${path}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// Load providers module once
const mod = await import("./providers.js");
providersRoutes = mod.providersRoutes;

beforeEach(async () => {
  // Back up the real .env so we can restore it after the test
  if (existsSync(ENV_PATH)) {
    await copyFile(ENV_PATH, ENV_BACKUP);
  }
});

afterEach(async () => {
  globalThis.fetch = originalFetch;

  // Restore original .env or remove the test one
  if (existsSync(ENV_BACKUP)) {
    await copyFile(ENV_BACKUP, ENV_PATH);
    await rm(ENV_BACKUP);
  } else {
    try { await rm(ENV_PATH); } catch { /* may not exist */ }
  }
});

// ============================================================================
// TESTS
// ============================================================================

describe("GET /tts - TTS provider listing", () => {
  test("returns both providers with elevenlabs active by default", async () => {
    await writeTestEnv({ ELEVENLABS_API_KEY: "sk-test-key" });

    const data = await getJson("/tts");

    assert.equal(data.active, "elevenlabs");
    const providers = data.providers as Array<Record<string, unknown>>;
    assert.equal(providers.length, 2);
    assert.equal(providers[0].type, "elevenlabs");
    assert.equal(providers[1].type, "deepgram");
  });

  test("returns active deepgram when TTS_PROVIDER is set", async () => {
    await writeTestEnv({
      TTS_PROVIDER: "deepgram",
      DEEPGRAM_API_KEY: "dg-test-key",
    });

    const data = await getJson("/tts");

    assert.equal(data.active, "deepgram");
  });

  test("shows elevenlabs ready and deepgram not ready when only elevenlabs key set", async () => {
    await writeTestEnv({ ELEVENLABS_API_KEY: "sk-test-key" });

    const data = await getJson("/tts");
    const providers = data.providers as Array<Record<string, unknown>>;

    const elStatus = providers[0].status as Record<string, unknown>;
    assert.equal(elStatus.ready, true);

    const dgStatus = providers[1].status as Record<string, unknown>;
    assert.equal(dgStatus.ready, false);
    assert.equal(dgStatus.reason, "missing_api_key");
  });

  test("shows both providers ready when both keys set", async () => {
    await writeTestEnv({
      ELEVENLABS_API_KEY: "sk-test-key",
      DEEPGRAM_API_KEY: "dg-test-key",
    });

    const data = await getJson("/tts");
    const providers = data.providers as Array<Record<string, unknown>>;

    const elStatus = providers[0].status as Record<string, unknown>;
    assert.equal(elStatus.ready, true);

    const dgStatus = providers[1].status as Record<string, unknown>;
    assert.equal(dgStatus.ready, true);
  });
});

describe("GET /stt - STT provider listing", () => {
  test("returns active from STT_PROVIDER env var", async () => {
    await writeTestEnv({ STT_PROVIDER: "deepgram" });

    const data = await getJson("/stt");

    assert.equal(data.active, "deepgram");
    const providers = data.providers as Array<Record<string, unknown>>;
    assert.equal(providers.length, 2);
  });

  test("defaults to elevenlabs when STT_PROVIDER is not set", async () => {
    await writeTestEnv({});

    const data = await getJson("/stt");

    assert.equal(data.active, "elevenlabs");
  });
});

describe("GET /deepgram/validate - Deepgram key validation", () => {
  test("returns valid when DEEPGRAM_API_KEY is set", async () => {
    await writeTestEnv({ DEEPGRAM_API_KEY: "dg-test-key" });

    const data = await getJson("/deepgram/validate");

    assert.equal(data.status, "valid");
  });

  test("returns missing when DEEPGRAM_API_KEY is not set", async () => {
    await writeTestEnv({});

    const data = await getJson("/deepgram/validate");

    assert.equal(data.status, "missing");
  });
});

describe("GET /elevenlabs/validate - ElevenLabs key validation", () => {
  test("returns valid when ELEVENLABS_API_KEY is set", async () => {
    await writeTestEnv({ ELEVENLABS_API_KEY: "sk-test-key" });

    const data = await getJson("/elevenlabs/validate");

    assert.equal(data.status, "valid");
  });

  test("returns missing when ELEVENLABS_API_KEY is not set", async () => {
    await writeTestEnv({});

    const data = await getJson("/elevenlabs/validate");

    assert.equal(data.status, "missing");
  });
});

describe("GET /tts/deepgram/voices - Deepgram voice listing", () => {
  test("returns non-empty hardcoded voice list", async () => {
    await writeTestEnv({});

    const data = await getJson("/tts/deepgram/voices");
    const voices = data.voices as Array<Record<string, string>>;

    assert.ok(voices.length > 0, "Expected at least one voice");
    assert.ok(voices[0].id, "Voice should have an id");
    assert.ok(voices[0].name, "Voice should have a name");

    // Verify a known voice is in the list
    const asteria = voices.find((v) => v.id === "aura-asteria-en");
    assert.ok(asteria, "Expected aura-asteria-en in voice list");
  });
});

describe("GET /tts/elevenlabs/voices - ElevenLabs voice listing", () => {
  test("returns empty array when no API key is configured", async () => {
    await writeTestEnv({});

    const data = await getJson("/tts/elevenlabs/voices");
    const voices = data.voices as Array<Record<string, string>>;

    assert.deepEqual(voices, []);
  });

  test("returns voices from ElevenLabs API when key is configured", async () => {
    await writeTestEnv({ ELEVENLABS_API_KEY: "sk-test-key" });

    // Mock fetch to return a fake voice list
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("api.elevenlabs.io")) {
        return new Response(
          JSON.stringify({
            voices: [
              { voice_id: "v1", name: "Rachel" },
              { voice_id: "v2", name: "Adam" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const data = await getJson("/tts/elevenlabs/voices");
    const voices = data.voices as Array<Record<string, string>>;

    assert.equal(voices.length, 2);
    assert.equal(voices[0].id, "v1");
    assert.equal(voices[0].name, "Rachel");
  });
});
