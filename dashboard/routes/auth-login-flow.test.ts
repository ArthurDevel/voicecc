/**
 * Regression tests for PTY login flow parsing logic.
 *
 * Covers two real bugs and the happy paths:
 * 1. ANSI escape codes (\x1b[39m) got appended to the OAuth URL
 * 2. Already-authenticated users timed out because the REPL wasn't detected
 *
 * Run: npx tsx --test dashboard/routes/auth-login-flow.test.ts
 */

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { stripAnsi, extractOAuthUrl, detectRepl } from "./auth.js";

describe("OAuth URL extraction from PTY output", () => {
  test("happy path: extracts URL from typical CLI output", () => {
    const output = "Browser didn't open? Use the url below to sign in (c to copy)\n\nhttps://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcode%2Fcallback\n";
    const url = extractOAuthUrl(output);
    assert.ok(url);
    assert.ok(url.startsWith("https://claude.ai/oauth/authorize"));
    assert.ok(url.includes("client_id="));
    assert.ok(url.includes("redirect_uri="));
  });

  test("bug: ANSI codes after URL don't corrupt it", () => {
    // Real VPS output: URL followed by \x1b[39m which became %1B%5B39m in browser
    const raw = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a&redirect_uri=https%3A%2F%2Fclaude.ai%2Foauth%2Fcode%2Fcallback\x1b[39m\n";
    const url = extractOAuthUrl(stripAnsi(raw));
    assert.ok(url);
    assert.ok(url.endsWith("callback"), "should not have ANSI trailing chars");
  });

  test("returns null during setup screens before URL appears", () => {
    assert.equal(extractOAuthUrl("Welcome to Claude Code\nChoose a theme"), null);
  });
});

describe("REPL detection for already-authenticated users", () => {
  test("happy path: detects REPL from real root user output", () => {
    assert.ok(detectRepl("◐ medium · /effort"));
  });

  test("happy path: detects cost indicator in REPL", () => {
    assert.ok(detectRepl("$0.00 this session"));
  });

  test("does not trigger on unauthenticated setup flow", () => {
    const setupScreens = [
      "Welcome to Claude Code v2.1.72",
      "Choose a theme\n1. Dark\n2. Light",
      "Opening browser to sign in…",
      "Browser didn't open?\nhttps://claude.ai/oauth/authorize?code=true",
    ];
    for (const screen of setupScreens) {
      assert.ok(!detectRepl(screen), `false positive on: ${screen.slice(0, 40)}`);
    }
  });
});
