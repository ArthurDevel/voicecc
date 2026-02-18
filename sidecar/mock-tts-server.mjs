/**
 * Minimal mock TTS server for testing.
 *
 * Speaks the same protocol as tts-server.py:
 * - stdin: JSON lines (generate, interrupt, quit)
 * - stdout: length-prefixed PCM chunks + 0-length end marker
 * - stderr: "READY" on startup
 *
 * Generates 480 bytes of silence (10ms at 24kHz mono 16-bit) per chunk.
 */

import { createInterface } from "readline";

const CHUNK_SIZE = 480; // 10ms of 24kHz mono 16-bit silence

process.stderr.write("READY\n");

let interrupted = false;

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.cmd === "generate") {
    interrupted = false;

    // Write one small PCM chunk (silence)
    if (!interrupted) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(CHUNK_SIZE, 0);
      process.stdout.write(header);
      process.stdout.write(Buffer.alloc(CHUNK_SIZE, 0));
    }

    // End marker
    const end = Buffer.alloc(4, 0);
    process.stdout.write(end);
  } else if (cmd.cmd === "interrupt") {
    interrupted = true;
  } else if (cmd.cmd === "quit") {
    process.exit(0);
  }
});
