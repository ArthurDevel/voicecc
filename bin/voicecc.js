#!/usr/bin/env node

/**
 * CLI entry point for the voicecc command.
 *
 * Responsibilities:
 * - On first run (no .env), launches an interactive setup wizard
 * - Copies CLAUDE.md template on first run
 * - Manages the server as a background daemon (start/stop/status)
 * - Supports subcommands: stop, logs, autostart
 */

import { spawn, execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");
const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");
const ENV_PATH = join(PKG_ROOT, ".env");

const VOICECC_DIR = join(homedir(), ".voicecc");
const PID_FILE = join(VOICECC_DIR, "voicecc.pid");
const LOG_FILE = join(VOICECC_DIR, "voicecc.log");
const STATUS_FILE = join(VOICECC_DIR, "status.json");

process.chdir(PKG_ROOT);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Ensure the ~/.voicecc directory exists.
 */
function ensureVoiceccDir() {
  if (!existsSync(VOICECC_DIR)) {
    mkdirSync(VOICECC_DIR, { recursive: true });
  }
}

/**
 * Prompt the user for a single line of input.
 *
 * @param rl - readline interface
 * @param question - the prompt text
 * @returns the user's trimmed answer
 */
function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Check if a command exists on the system PATH.
 *
 * @param cmd - the command name to look up
 * @returns true if the command is found
 */
function commandExists(cmd) {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a cryptographically random password (24 URL-safe characters).
 *
 * @returns generated password string
 */
function generatePassword() {
  return randomBytes(18).toString("base64url");
}

/**
 * Check if the daemon is currently running.
 *
 * @returns true if the PID file exists and the process is alive
 */
function isRunning() {
  if (!existsSync(PID_FILE)) return false;

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  if (isNaN(pid)) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not found, clean up stale PID file
    unlinkSync(PID_FILE);
    return false;
  }
}

/**
 * Read the status.json written by the server.
 *
 * @returns parsed status object or null if unavailable
 */
function readStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Display server info banner.
 */
function showInfo() {
  const status = readStatus();

  console.log("");
  console.log("========================================");
  console.log("          VOICECC RUNNING               ");
  console.log("========================================");
  console.log("");

  if (status) {
    console.log(`  Dashboard:  http://localhost:${status.dashboardPort}`);
    console.log(`  Tunnel:     ${status.tunnelUrl ?? "disabled"}`);
  } else {
    console.log("  Server is starting up...");
    console.log("  Run 'voicecc' again in a few seconds to see details.");
  }

  console.log("");
  console.log("  Logs:       voicecc logs");
  console.log("  Stop:       voicecc stop");
  console.log("");
  console.log("  TIP: Run 'voicecc autostart' to start VoiceCC");
  console.log("  automatically on reboot.");
  console.log("");
  console.log("========================================");
  console.log("");
}

// ============================================================================
// SETUP WIZARD
// ============================================================================

/**
 * Run the first-run setup wizard.
 * Prompts for ElevenLabs API key and dashboard password configuration.
 * Writes results to .env.
 */
async function runSetupWizard() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("");
  console.log("========================================");
  console.log("       Welcome to VoiceCC Setup!        ");
  console.log("========================================");
  console.log("");

  // ElevenLabs API key
  console.log("VoiceCC uses ElevenLabs for speech recognition and text-to-speech.");
  console.log("You can get a free API key at: https://elevenlabs.io");
  console.log("");
  const apiKey = await ask(rl, "Paste your ElevenLabs API key (or press Enter to skip): ");
  if (!apiKey) {
    console.log("Skipped. You can add it later from the dashboard.");
  }

  // Dashboard password
  console.log("");
  console.log("Would you like to protect your dashboard with a password?");
  console.log("Anyone with access to the dashboard can control your voice agents.");
  console.log("");
  console.log("  1) Yes, generate a password for me (recommended)");
  console.log("  2) No, leave it open (not recommended)");
  console.log("");
  const passwordChoice = await ask(rl, "Choose [1/2]: ");

  let password = "";
  if (passwordChoice === "2") {
    console.log("");
    console.log("WARNING: Your dashboard will be open to anyone who can reach it.");
  } else {
    password = generatePassword();
    console.log("");
    console.log("========================================");
    console.log("  Your dashboard login (save this!)     ");
    console.log("========================================");
    console.log("");
    console.log(`  Username: admin`);
    console.log(`  Password: ${password}`);
    console.log("");
    console.log("  \x1b[31mThis will NOT be shown again.\x1b[0m");
    console.log("  Your browser will ask for these when");
    console.log("  you open the dashboard.");
    console.log("========================================");
    console.log("");
    await ask(rl, "Have you saved the password? Press Enter to continue. ");
  }

  // Tunnel
  console.log("");
  console.log("Would you like to enable a public tunnel (via Cloudflare)?");
  console.log("This is required if you want to access VoiceCC on a remote");
  console.log("server, and/or want to make use of phone calling.");
  console.log("");
  console.log("  1) Yes, enable tunnel (recommended)");
  console.log("  2) No, local only");
  console.log("");
  const tunnelChoice = await ask(rl, "Choose [1/2]: ");
  const tunnelEnabled = tunnelChoice !== "2";
  if (tunnelEnabled) {
    console.log("Tunnel will start automatically on boot.");
  } else {
    console.log("Tunnel disabled. You can enable it later from Settings.");
  }

  // Claude CLI
  if (!commandExists("claude")) {
    console.log("");
    console.log("Claude Code CLI not found. It will be installed globally now.");
    await ask(rl, "Press Enter to continue. ");
    console.log("Installing @anthropic-ai/claude-code globally...");
    try {
      execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
      console.log("Claude CLI installed.");
    } catch {
      console.log("");
      console.log("Failed to install Claude CLI. Install it manually:");
      console.log("  npm install -g @anthropic-ai/claude-code");
      console.log("");
      rl.close();
      process.exit(1);
    }
  }

  rl.close();

  // Build .env content
  const lines = [];
  if (apiKey) lines.push(`ELEVENLABS_API_KEY=${apiKey}`);
  if (password) lines.push(`DASHBOARD_PASSWORD=${password}`);
  lines.push(`TUNNEL_ENABLED=${tunnelEnabled}`);
  await writeFile(ENV_PATH, lines.join("\n") + "\n", "utf-8");

  console.log("All done! Starting VoiceCC...");
  console.log("");
}

// ============================================================================
// ROOT PRIVILEGE DROP
// ============================================================================

const VOICECC_USER = "voicecc";

/**
 * Ensure a non-root user exists for running the server.
 * Creates the user if it doesn't exist (Linux only).
 */
function ensureNonRootUser() {
  try {
    execSync(`id ${VOICECC_USER}`, { stdio: "ignore" });
  } catch {
    console.log(`Creating '${VOICECC_USER}' user...`);
    execSync(`useradd -r -m -s /bin/bash ${VOICECC_USER}`, { stdio: "inherit" });
  }
}

/**
 * Give the voicecc user ownership of the package directory so it can
 * read config, write .env, etc.
 */
function chownPkgRoot() {
  execSync(`chown -R ${VOICECC_USER}:${VOICECC_USER} ${PKG_ROOT}`, { stdio: "inherit" });
}

// ============================================================================
// SUBCOMMANDS
// ============================================================================

/**
 * Stop the running daemon.
 */
function stopDaemon() {
  if (!isRunning()) {
    console.log("VoiceCC is not running.");
    process.exit(0);
  }

  const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
  console.log(`Stopping VoiceCC (PID ${pid})...`);

  // Kill the entire process group (negative PID) so child processes
  // like cloudflared and tsx's Node subprocess are also terminated.
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Fall back to killing just the main PID
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }

  // Wait for the process to actually die (up to 5 seconds)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      break; // Process is gone
    }
    // Busy-wait in small increments
    const waitUntil = Date.now() + 100;
    while (Date.now() < waitUntil) { /* spin */ }
  }

  // Force kill if still alive
  try {
    process.kill(-pid, "SIGKILL");
  } catch { /* already dead */ }

  // Clean up
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  try { unlinkSync(STATUS_FILE); } catch { /* ignore */ }

  console.log("VoiceCC stopped.");
}

/**
 * Tail the log file.
 */
function showLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("No log file found. Has VoiceCC been started?");
    process.exit(1);
  }

  const child = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * Set up auto-start on reboot using systemd (Linux) or launchd (macOS).
 */
function setupAutostart() {
  const os = platform();

  if (os === "linux") {
    setupSystemdAutostart();
  } else if (os === "darwin") {
    setupLaunchdAutostart();
  } else {
    console.log(`Autostart is not supported on ${os}.`);
    process.exit(1);
  }
}

/**
 * Install a systemd service for auto-start on Linux.
 * Requires sudo for writing to /etc/systemd/system.
 */
function setupSystemdAutostart() {
  const user = execSync("whoami", { encoding: "utf-8" }).trim();

  const serviceContent = `[Unit]
Description=VoiceCC Voice Server
After=network.target

[Service]
Type=simple
User=${user}
ExecStart=${TSX_BIN} server/index.ts
Restart=on-failure
RestartSec=5
Environment=HOME=${homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin
WorkingDirectory=${PKG_ROOT}

[Install]
WantedBy=multi-user.target
`;

  const tmpPath = join(VOICECC_DIR, "voicecc.service");
  writeFileSync(tmpPath, serviceContent);

  console.log("Installing systemd service (sudo required)...");
  console.log("");

  try {
    execSync(`sudo cp ${tmpPath} /etc/systemd/system/voicecc.service`, { stdio: "inherit" });
    execSync("sudo systemctl daemon-reload", { stdio: "inherit" });
    execSync("sudo systemctl enable voicecc", { stdio: "inherit" });
    console.log("");
    console.log("Autostart enabled! VoiceCC will start on reboot.");
    console.log("The systemd service manages the daemon separately.");
    console.log("");
    console.log("  sudo systemctl start voicecc    Start now via systemd");
    console.log("  sudo systemctl stop voicecc     Stop via systemd");
    console.log("  sudo systemctl status voicecc   Check status");
    console.log("");
  } catch {
    console.log("Failed to install systemd service. Check sudo permissions.");
    process.exit(1);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Install a launchd agent for auto-start on macOS.
 * No sudo required (user-level agent).
 */
function setupLaunchdAutostart() {
  const plistName = "com.voicecc.server";
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${plistName}.plist`);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${TSX_BIN}</string>
    <string>server/index.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${PKG_ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
</dict>
</plist>
`;

  if (!existsSync(plistDir)) {
    mkdirSync(plistDir, { recursive: true });
  }

  try {
    // Unload existing if present
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload ${plistPath}`, { stdio: "ignore" });
      } catch { /* ignore */ }
    }

    writeFileSync(plistPath, plistContent);
    execSync(`launchctl load ${plistPath}`, { stdio: "inherit" });

    console.log("");
    console.log("Autostart enabled! VoiceCC will start on login.");
    console.log("");
    console.log(`  Plist: ${plistPath}`);
    console.log("");
    console.log("  To disable autostart:");
    console.log(`    launchctl unload ${plistPath}`);
    console.log("");
  } catch (err) {
    console.log(`Failed to install launchd agent: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Start the server as a detached background daemon.
 */
function startDaemon() {
  ensureVoiceccDir();

  // Clean up stale status file
  try { unlinkSync(STATUS_FILE); } catch { /* ignore */ }

  const logFd = openSync(LOG_FILE, "a");

  const isRoot = process.getuid && process.getuid() === 0;

  let child;
  if (isRoot) {
    ensureNonRootUser();
    chownPkgRoot();
    console.log(`Dropping root privileges, running as '${VOICECC_USER}'...`);

    // Resolve uid/gid for the voicecc user so we can drop privileges
    // via spawn options instead of `su`, which can leak stdio and
    // cause PID tracking issues.
    const uid = parseInt(execSync(`id -u ${VOICECC_USER}`, { encoding: "utf-8" }).trim(), 10);
    const gid = parseInt(execSync(`id -g ${VOICECC_USER}`, { encoding: "utf-8" }).trim(), 10);

    child = spawn(TSX_BIN, ["server/index.ts"], {
      cwd: PKG_ROOT,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      uid,
      gid,
      env: { ...process.env, HOME: `/home/${VOICECC_USER}`, USER: VOICECC_USER, VOICECC_DIR },
    });
  } else {
    child = spawn(TSX_BIN, ["server/index.ts"], {
      cwd: PKG_ROOT,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  }

  // Write PID file
  writeFileSync(PID_FILE, String(child.pid));

  // Detach parent from child
  child.unref();
  closeSync(logFd);
}

// ============================================================================
// MAIN ENTRYPOINT
// ============================================================================

const subcommand = process.argv[2];

// Handle subcommands
if (subcommand === "stop") {
  stopDaemon();
  process.exit(0);
}

if (subcommand === "logs") {
  showLogs();
  // showLogs doesn't return (tail -f)
}

if (subcommand === "autostart") {
  ensureVoiceccDir();
  setupAutostart();
  process.exit(0);
}

// Copy CLAUDE.md template if available
const claudeMdSrc = join("init", "CLAUDE.md");
if (existsSync(claudeMdSrc)) {
  copyFileSync(claudeMdSrc, "CLAUDE.md");
}

// Run setup wizard on first run (no .env file)
if (!existsSync(ENV_PATH)) {
  await runSetupWizard();
}

// If already running, show info and exit
if (isRunning()) {
  showInfo();
  process.exit(0);
}

// Start the daemon
startDaemon();

// Poll for status.json until the server is ready
const tunnelEnabled = readFileSync(ENV_PATH, "utf-8").includes("TUNNEL_ENABLED=true");
const MAX_WAIT_MS = tunnelEnabled ? 30000 : 10000;
const POLL_INTERVAL_MS = 500;
const startTime = Date.now();

while (Date.now() - startTime < MAX_WAIT_MS) {
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  const status = readStatus();
  if (status && (!tunnelEnabled || status.tunnelUrl)) break;
}

showInfo();
