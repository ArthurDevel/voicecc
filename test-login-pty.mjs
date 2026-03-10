/**
 * Test: PTY-based Claude CLI login flow for headless VPS.
 *
 * THIS IS THE WORKING APPROACH. The Claude CLI uses Ink (React TUI) which
 * requires a real TTY — regular child_process.spawn with piped stdio is
 * ignored. node-pty creates a proper pseudo-TTY that the CLI recognizes.
 *
 * Key findings:
 * - `claude auth login` (standalone) always enters "browser mode" — NOT the
 *   interactive "paste code" flow. You must use the interactive `claude`
 *   session which goes through first-time setup for unauthenticated users.
 * - The voicecc user (unauthenticated) goes through: Welcome → Theme picker →
 *   Login method → OAuth URL. Each screen has a selection prompt rendered via
 *   ANSI cursor positioning (❯) which is invisible in raw PTY data.
 * - Solution: press Enter every 2s to blindly advance through all prompts.
 *   The OAuth URL appears after ~12s.
 * - For already-authenticated users (e.g. root), the CLI goes straight to the
 *   REPL which shows "◐ medium · /effort". We detect this and exit early.
 * - The URL must be extracted from ANSI-stripped output, otherwise escape
 *   codes like \x1b[39m get appended to the URL.
 * - cols: 2000 prevents the URL from being truncated/wrapped.
 *
 * Usage (on VPS):
 *   node /tmp/test-login-pty.mjs              # as root (detects REPL)
 *   su -s /bin/bash -c 'cd /tmp && node /tmp/test-login-pty.mjs' voicecc  # gets URL
 *
 * Prerequisites:
 *   npm install node-pty   (in /tmp on VPS: cd /tmp && npm install node-pty)
 *   Node v24 (node-pty fails on v25 with posix_spawnp error)
 */

import pty from "node-pty";

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";

const child = pty.spawn(CLAUDE_PATH, [], {
  name: "xterm-256color",
  cols: 2000,  // wide to avoid URL truncation
  rows: 50,
});

let output = "";
let resolved = false;
let enterCount = 0;

child.onData((data) => {
  output += data;
  const clean = data.replace(/\x1b\[[^m]*m/g, "").replace(/\r/g, "").trim();
  if (clean) process.stdout.write("[data] " + clean.slice(0, 200) + "\n");

  if (resolved) return;

  // Strip ANSI before matching to avoid escape codes in the URL
  const stripped = output.replace(/\x1b\[[^m]*m/g, "");

  // Check for OAuth URL
  const urlMatch = stripped.match(/(https:\/\/claude\.ai\/oauth\/authorize\S+)/);
  if (urlMatch) {
    resolved = true;
    process.stdout.write("\nURL FOUND: " + urlMatch[1].slice(0, 120) + "...\n");
    setTimeout(() => { child.kill(); process.exit(0); }, 1000);
    return;
  }

  // Detect REPL — already authenticated.
  // After at least 1 Enter, if we see REPL indicators but no OAuth URL,
  // the user is already logged in.
  if (enterCount >= 1) {
    const replIndicators = [
      /\/effort/,       // effort command shown in REPL status bar
      /◐.*medium/,     // model indicator: "◐ medium · /effort"
      /\$\d+\.\d+/,     // cost like $0.00
      /what can i help/i,
    ];
    for (const pattern of replIndicators) {
      if (pattern.test(stripped)) {
        resolved = true;
        process.stdout.write("\nREPL DETECTED — ALREADY AUTHENTICATED (matched: " + pattern + ")\n");
        child.kill();
        process.exit(0);
        return;
      }
    }
  }
});

child.onExit(({ exitCode }) => {
  process.stdout.write("[exit] code=" + exitCode + "\n");
  process.exit(0);
});

// Press Enter every 2s to advance through setup prompts.
// Can't detect individual prompts because ❯ is rendered via
// ANSI cursor positioning, invisible in raw PTY data.
const interval = setInterval(() => {
  if (resolved) { clearInterval(interval); return; }
  enterCount++;
  process.stdout.write("=== ENTER #" + enterCount + " ===\n");
  child.write("\r");
}, 2000);

setTimeout(() => {
  if (resolved) return;
  process.stdout.write("\n=== TIMEOUT 30s ===\n");
  process.stdout.write("Last output (stripped):\n" + output.replace(/\x1b\[[^m]*m/g, "").slice(-500) + "\n");
  child.kill();
  process.exit(1);
}, 30000);
