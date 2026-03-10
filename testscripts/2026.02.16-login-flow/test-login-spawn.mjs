/**
 * Test: spawn `claude auth login` with piped stdio (NO PTY).
 *
 * RESULT: DOES NOT WORK.
 *
 * The Claude CLI uses Ink (React TUI) which reads from the TTY directly,
 * not from stdin. With piped stdio, the CLI ignores any input written to
 * stdin. Additionally, `claude auth login` as a standalone command always
 * enters "browser mode" — it opens a browser and waits, rather than
 * showing the interactive "Paste code here" prompt.
 *
 * This script is kept as a reference to document WHY we need node-pty.
 * See test-login-pty.mjs for the working approach.
 *
 * Usage: node test-login-spawn.mjs
 */

import { spawn } from "child_process";
import { createInterface } from "readline";

// Force "no browser" mode to simulate headless VPS
const child = spawn("claude", ["auth", "login"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    BROWSER: "false",
    DISPLAY: "",
  },
});

let output = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  console.log("[stdout]", JSON.stringify(text));
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  output += text;
  console.log("[stderr]", JSON.stringify(text));
});

child.on("exit", (code) => {
  console.log(`[exit] code=${code}`);
  console.log("[full output]", JSON.stringify(output));
  process.exit(0);
});

child.on("error", (err) => {
  console.log("[error]", err.message);
});

// After 5s, check what we got and try sending a code
setTimeout(() => {
  console.log("\n--- Output after 5s ---");
  console.log(JSON.stringify(output));

  if (!output) {
    console.log("No output -- CLI likely needs a TTY. Try node-pty.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("\nPaste the auth code here: ", (code) => {
    console.log(`[writing to stdin] "${code}"`);
    child.stdin.write(code + "\n");

    setTimeout(() => {
      console.log("\n--- Output after code ---");
      console.log(JSON.stringify(output));
    }, 5000);

    setTimeout(() => {
      console.log("\n--- Final ---");
      console.log(JSON.stringify(output));
      if (!child.killed) child.kill();
      process.exit(0);
    }, 15000);

    rl.close();
  });
}, 5000);
