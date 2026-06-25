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

// A fixed "staging backend" warning bar injected into Heard's `src/main.tsx` by
// wire:heard and stripped by unwire:heard (and hidden from git via
// --skip-worktree, so it is never committed). It is plain DOM — no React/JSX or
// Heard CSS dependencies — so it survives changes to Heard's component tree, and
// is gated on VITE_SUPABASE_FUNCTIONS_URL, which only wire:heard ever sets. That
// means the bar appears iff the frontend is pointed at this local stack.
export const STAGING_BANNER_BEGIN =
  "/* heard-staging:banner:begin (injected by wire:heard — do not commit) */";
export const STAGING_BANNER_END = "/* heard-staging:banner:end */";

export function stagingBannerBlock(eol = "\n") {
  return [
    STAGING_BANNER_BEGIN,
    "{",
    "  const __stagingUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL;",
    '  if (__stagingUrl && typeof document !== "undefined") {',
    '    let __host = "local Supabase";',
    "    try { __host = new URL(__stagingUrl).host; } catch {}",
    '    const __b = document.createElement("div");',
    '    __b.setAttribute("data-heard-staging-banner", "");',
    "    __b.textContent = `⚠  STAGING BACKEND · ${__host} — not production data`;",
    "    Object.assign(__b.style, {",
    '      position: "fixed", top: "0", left: "0", right: "0", zIndex: "2147483647",',
    '      padding: "6px 12px", textAlign: "center", pointerEvents: "none",',
    '      font: "600 13px/1.4 system-ui, -apple-system, Segoe UI, sans-serif",',
    '      letterSpacing: "0.04em", color: "#fff",',
    '      background: "repeating-linear-gradient(45deg,#b45309 0 12px,#92400e 12px 24px)",',
    '      boxShadow: "0 1px 4px rgba(0,0,0,.35)",',
    "    });",
    "    const __mount = () => {",
    "      document.body.prepend(__b);",
    "      document.body.style.paddingTop = `${__b.offsetHeight}px`;",
    "    };",
    "    if (document.body) __mount();",
    '    else addEventListener("DOMContentLoaded", __mount, { once: true });',
    "  }",
    "}",
    STAGING_BANNER_END,
  ].join(eol) + eol;
}

// Remove the injected banner block from `src` and restore it to how it looked
// before injection (so the file matches HEAD again and leaves no git trace).
// Pure string slicing — robust against regex-significant chars in the markers.
export function stripStagingBanner(src) {
  const start = src.indexOf(STAGING_BANNER_BEGIN);
  const endMarker = src.indexOf(STAGING_BANNER_END);
  if (start === -1 || endMarker === -1) return { src, removed: false };
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const end = endMarker + STAGING_BANNER_END.length;
  const before = src.slice(0, start).replace(/\s*$/, "");
  const after = src.slice(end).replace(/^\s*/, "");
  const out = before + eol + after;
  return { src: out.endsWith(eol) ? out : out + eol, removed: true };
}

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
