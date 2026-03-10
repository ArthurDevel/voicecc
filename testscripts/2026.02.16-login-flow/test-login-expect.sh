#!/usr/bin/env expect
#
# Test: use expect to spawn `claude auth login` with a real PTY.
#
# RESULT: PARTIALLY WORKS but wrong flow.
#
# The expect tool creates a PTY, so the CLI does produce output.
# However, `claude auth login` (standalone command) always enters
# "browser mode" — it opens a browser automatically instead of
# showing the interactive "Paste code here" prompt. On a headless
# VPS it falls back to showing a URL + waiting for browser callback.
#
# The correct approach is to spawn the interactive `claude` session
# (not `claude auth login`) and press Enter through the first-time
# setup prompts until the OAuth URL appears. See test-login-pty.mjs.
#
# Usage:
#   expect test-login-expect.sh
#   # or: chmod +x test-login-expect.sh && ./test-login-expect.sh

set timeout 60

spawn claude auth login

# Wait for the "Paste code" prompt
expect {
    -re "Paste code" {
        puts "\n\n=== GOT PASTE CODE PROMPT ==="
        puts "=== Now type/paste the code and press Enter ==="
        interact
    }
    -re "Login successful" {
        puts "\n=== Login succeeded (browser flow) ==="
    }
    -re "Opening browser" {
        puts "\n=== Got browser mode, waiting more... ==="
        exp_continue
    }
    timeout {
        puts "\n=== TIMEOUT ==="
    }
}
