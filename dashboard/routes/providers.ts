/**
 * Provider status and on-demand setup API routes.
 *
 * Exposes TTS/STT provider information, readiness status, and triggers
 * for on-demand local model installation from the dashboard:
 * - GET /tts -- list TTS providers with status
 * - GET /tts/status/:type -- check a specific TTS provider
 * - GET /stt -- list STT providers with status
 * - GET /stt/status/:type -- check a specific STT provider
 * - POST /setup/local-tts -- trigger local TTS setup (background job)
 * - POST /setup/local-stt -- trigger local STT setup (background job)
 * - GET /setup/status/:jobId -- poll setup job progress and logs
 */

import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

import { Hono } from "hono";

import { getAvailableTtsProviders, getTtsProviderStatus } from "../../sidecar/tts-provider.js";
import { getAvailableSttProviders, getSttProviderStatus } from "../../sidecar/stt-provider.js";
import { readEnv } from "../../services/env.js";

import type { TtsProviderType } from "../../sidecar/types.js";
import type { SttProviderType } from "../../sidecar/types.js";

// ============================================================================
// TYPES
// ============================================================================

/** Tracks a background setup job */
interface SetupJob {
  /** Whether the child process is still running */
  running: boolean;
  /** Child process exit code (null while running) */
  exitCode: number | null;
  /** Path to the log file capturing stdout + stderr */
  logFile: string;
}

// ============================================================================
// STATE
// ============================================================================

/** Active and completed setup jobs keyed by job ID */
const setupJobs = new Map<string, SetupJob>();

// ============================================================================
// ROUTES
// ============================================================================

/**
 * Create Hono route group for provider status and setup operations.
 *
 * @returns Hono instance with TTS/STT status and setup routes
 */
export function providersRoutes(): Hono {
  const app = new Hono();

  // ---- TTS routes ----

  /** List all TTS providers with their current status */
  app.get("/tts", async (c) => {
    const providers = getAvailableTtsProviders();
    const env = await readEnv();
    const active = env.TTS_PROVIDER || "local";

    const providersWithStatus = await Promise.all(
      providers.map(async (p) => ({
        ...p,
        status: await getTtsProviderStatus(p.type),
      }))
    );

    return c.json({ providers: providersWithStatus, active });
  });

  /** Check readiness of a specific TTS provider */
  app.get("/tts/status/:type", async (c) => {
    const type = c.req.param("type") as TtsProviderType;
    const status = await getTtsProviderStatus(type);
    return c.json(status);
  });

  // ---- STT routes ----

  /** List all STT providers with their current status */
  app.get("/stt", async (c) => {
    const providers = getAvailableSttProviders();
    const env = await readEnv();
    const active = env.STT_PROVIDER || "local";

    const providersWithStatus = await Promise.all(
      providers.map(async (p) => ({
        ...p,
        status: await getSttProviderStatus(p.type),
      }))
    );

    return c.json({ providers: providersWithStatus, active });
  });

  /** Check readiness of a specific STT provider */
  app.get("/stt/status/:type", async (c) => {
    const type = c.req.param("type") as SttProviderType;
    const status = await getSttProviderStatus(type);
    return c.json(status);
  });

  // ---- Setup routes ----

  /** Trigger local TTS setup as a background job */
  app.post("/setup/local-tts", async (c) => {
    const jobId = startSetupJob("local-tts");
    return c.json({ jobId });
  });

  /** Trigger local STT setup as a background job */
  app.post("/setup/local-stt", async (c) => {
    const jobId = startSetupJob("local-stt");
    return c.json({ jobId });
  });

  /** Poll a setup job for progress and log output */
  app.get("/setup/status/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const job = setupJobs.get(jobId);

    if (!job) {
      return c.json({ error: "Unknown job ID" }, 404);
    }

    const log = await readFile(job.logFile, "utf-8").catch(() => "");

    return c.json({
      running: job.running,
      exitCode: job.exitCode,
      log,
    });
  });

  return app;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Spawn a background child process to run a setup script.
 * Captures stdout + stderr to a temp log file for polling.
 *
 * @param target - Which setup to run ("local-tts" or "local-stt")
 * @returns The job ID for polling status
 */
function startSetupJob(target: "local-tts" | "local-stt"): string {
  const jobId = randomUUID();
  const logFile = join(tmpdir(), `voicecc-setup-${jobId}.log`);
  const logStream = createWriteStream(logFile);

  // Build the inline script that imports and runs the setup function
  const scriptPath = target === "local-tts"
    ? "./scripts/setup-local-tts.js"
    : "./scripts/setup-local-stt.js";
  const fnName = target === "local-tts" ? "setupLocalTts" : "setupLocalStt";
  const inlineScript = `import('${scriptPath}').then(m => m.${fnName}()).catch(e => { console.error(e.message); process.exit(1); })`;

  const child = spawn("node", ["--input-type=module", "-e", inlineScript], {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: process.cwd(),
  });

  const job: SetupJob = { running: true, exitCode: null, logFile };
  setupJobs.set(jobId, job);

  // Pipe both stdout and stderr to the log file
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });

  child.on("close", (code) => {
    const exitCode = code ?? 1;
    const doneMsg = exitCode === 0
      ? `\n[setup] Completed successfully.\n`
      : `\n[setup] Failed with exit code ${exitCode}.\n`;
    logStream.write(doneMsg);
    logStream.end();

    job.running = false;
    job.exitCode = exitCode;
  });

  child.on("error", (err) => {
    logStream.write(`\n[setup] Process error: ${err.message}\n`);
    logStream.end();
    job.running = false;
    job.exitCode = 1;
  });

  return jobId;
}
