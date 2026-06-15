// Shared helpers for the heard-staging scripts.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Location of the Heard repo. Defaults to a sibling directory named "heard".
export function heardRepoPath() {
  const fromEnv = process.env.HEARD_REPO_PATH;
  const candidate = fromEnv
    ? path.resolve(fromEnv)
    : path.resolve(ROOT, "..", "heard");
  if (!existsSync(path.join(candidate, "src", "supabase", "functions", "server"))) {
    throw new Error(
      `Could not find the Heard repo at ${candidate}. ` +
        `Set HEARD_REPO_PATH to its location.`,
    );
  }
  return candidate;
}

// The function URL the Heard frontend should point at.
export const FUNCTION_NAME = "make-server-f1a393b4";
export function functionsUrl(host = "127.0.0.1") {
  return `http://${host}:54321/functions/v1/${FUNCTION_NAME}`;
}
export const LOCAL_FUNCTIONS_URL = functionsUrl();

// Best-effort LAN IPv4 for serving Heard to other computers. Skips loopback and
// virtual adapters (WSL/Hyper-V/Docker switches) so we land on the real NIC.
export function detectLanIp() {
  const ifaces = os.networkInterfaces();
  const isVirtual = (name) => /vethernet|wsl|hyper-v|default switch|loopback|docker|virtualbox|vmware/i.test(name);
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (isVirtual(name)) continue;
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) candidates.push(a.address);
    }
  }
  // Prefer common private LAN ranges.
  return (
    candidates.find((ip) => ip.startsWith("192.168.")) ||
    candidates.find((ip) => ip.startsWith("10.")) ||
    candidates.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidates[0] ||
    null
  );
}

// Default local-stack anon key (issuer "supabase-demo"). `supabase start` has
// used this fixed value for years; wire-heard.mjs prefers the live value from
// `supabase status` when the stack is running and only falls back to this.
export const DEFAULT_LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Run a command, inheriting stdio. Returns the exit code.
export function run(command, opts = {}) {
  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    cwd: ROOT,
    ...opts,
  });
  return result.status ?? 1;
}

// Run a command and capture stdout (trimmed). Returns null on failure.
export function capture(command, opts = {}) {
  const result = spawnSync(command, {
    shell: true,
    cwd: ROOT,
    encoding: "utf8",
    ...opts,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

export function dockerIsRunning() {
  const result = spawnSync("docker info", {
    shell: true,
    stdio: "ignore",
    cwd: ROOT,
  });
  return result.status === 0;
}
