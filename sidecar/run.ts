/**
 * Wrapper that spawns the voice sidecar and filters its output.
 * Aggregates native CoreAudio buffer underflow warnings into single summary lines.
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

const UNDERFLOW = "buffer underflow";
let count = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (count > 0) {
    process.stderr.write(`[coreaudio] buffer underflow x${count}\n`);
    count = 0;
  }
  timer = null;
}

function filter(line: string, dest: NodeJS.WritableStream) {
  if (line.includes(UNDERFLOW)) {
    count++;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 2000);
    return;
  }
  // Non-underflow line: flush pending count first so it appears in-place
  flush();
  dest.write(line + "\n");
}

const child = spawn(process.execPath, ["--import", "tsx", "sidecar/index.ts"], {
  stdio: ["inherit", "pipe", "pipe"],
  env: process.env,
});

createInterface({ input: child.stdout! }).on("line", (l) => filter(l, process.stdout));
createInterface({ input: child.stderr! }).on("line", (l) => filter(l, process.stderr));

// Forward signals
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

child.on("exit", (code) => {
  flush();
  process.exit(code ?? 1);
});
