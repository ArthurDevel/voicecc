/**
 * Tagged mock TTS server for reproducing stale-audio bugs.
 *
 * Like mock-tts-server.mjs but with two differences:
 * - Tags each PCM chunk with a generation counter byte (0x01, 0x02, ...)
 *   so tests can identify which generation produced a given chunk.
 * - Deliberately ignores the interrupt command during generation, simulating
 *   the real tts-server.py bug where interrupt can't be processed while the
 *   main thread is blocked writing audio to stdout.
 * - Writes chunks with small delays to simulate real TTS generation latency.
 *
 * Protocol: same as tts-server.py (JSON stdin, length-prefixed PCM stdout).
 *
 * Run: node sidecar/mock-tts-server-tagged.mjs
 */

import { createInterface } from "readline";

// ============================================================================
// CONSTANTS
// ============================================================================

/** 10ms of 24kHz mono 16-bit silence */
const CHUNK_SIZE = 480;

/** Number of chunks per generate command */
const CHUNKS_PER_GENERATE = 15;

/** Delay between chunks (ms) -- simulates real TTS generation latency */
const CHUNK_DELAY_MS = 10;

// ============================================================================
// STATE
// ============================================================================

/** Monotonically increasing generation counter. First generate = 1. */
let genCounter = 0;

/** Serial command queue (like Python's blocking for-line-in-stdin loop) */
const pendingCommands = [];
let processing = false;

// ============================================================================
// HELPERS
// ============================================================================

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeChunk(tag) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(CHUNK_SIZE, 0);
  process.stdout.write(header);
  process.stdout.write(Buffer.alloc(CHUNK_SIZE, tag));
}

function writeEndMarker() {
  process.stdout.write(Buffer.alloc(4, 0));
}

// ============================================================================
// COMMAND PROCESSING
// ============================================================================

/**
 * Process commands serially, like the real Python server.
 * A new generate cannot start until the previous one finishes.
 */
async function drainQueue() {
  if (processing) return;
  processing = true;

  while (pendingCommands.length > 0) {
    const cmd = pendingCommands.shift();
    await handleCommand(cmd);
  }

  processing = false;
}

async function handleCommand(cmd) {
  if (cmd.cmd === "generate") {
    genCounter++;
    const tag = genCounter & 0xff;

    for (let i = 0; i < CHUNKS_PER_GENERATE; i++) {
      await sleep(CHUNK_DELAY_MS);
      writeChunk(tag);
    }

    writeEndMarker();
  }
  // "interrupt" is deliberately ignored -- simulates the Python bug where
  // the main thread can't read the interrupt command while blocked in
  // the generate loop writing audio to stdout.
}

// ============================================================================
// ENTRY POINT
// ============================================================================

process.stderr.write("READY\n");

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.cmd === "quit") {
    process.exit(0);
  }

  pendingCommands.push(cmd);
  drainQueue();
});
