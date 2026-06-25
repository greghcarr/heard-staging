// Point the Heard frontend at this local backend by writing Heard's gitignored
// `.env.local`, and apply the one-line override in `src/utils/api-client.ts`
// (kept out of git via `--skip-worktree`). This is the entire footprint inside
// the Heard repo, and none of it is ever committed.
//
//   npm run wire:heard      enable the local backend
//   npm run unwire:heard    revert (see unwire-heard.mjs)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  heardRepoPath,
  capture,
  run,
  functionsUrl,
  detectLanIp,
  DEFAULT_LOCAL_ANON_KEY,
  stagingBannerBlock,
  STAGING_BANNER_BEGIN,
} from "./lib.mjs";

// Choose the host other machines / the browser will use to reach the backend.
//   (no flag)        -> 127.0.0.1   (this computer only)
//   --host lan       -> auto-detected LAN IP (reachable from the LAN)
//   --host 1.2.3.4   -> that exact address
function resolveHost(argv) {
  const i = argv.findIndex((a) => a === "--host" || a.startsWith("--host="));
  if (i === -1) return "127.0.0.1";
  let val = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  if (!val || val === "lan") {
    const ip = detectLanIp();
    if (!ip) throw new Error("Could not auto-detect a LAN IP; pass --host <ip> explicitly.");
    return ip;
  }
  return val;
}

const HEARD_API_SECRET = "heard-local-dev-secret"; // must match supabase/functions/.env

// The exact line shipped in Heard, and the override we replace it with.
const ORIGINAL_LINE =
  "export const API_BASE_URL = `https://${projectId}.supabase.co/functions/v1/make-server-f1a393b4`;";
const OVERRIDE_LINE =
  "export const API_BASE_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || `https://${projectId}.supabase.co/functions/v1/make-server-f1a393b4`;";

function readLiveAnonKey() {
  // Prefer the running stack's real anon key.
  const env = capture("npx supabase status -o env");
  if (env) {
    const m = env.match(/^ANON_KEY="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  return DEFAULT_LOCAL_ANON_KEY;
}

function upsertEnv(contents, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(contents)) return contents.replace(re, line);
  return (contents.endsWith("\n") || contents === "" ? contents : contents + "\n") + line + "\n";
}

function main() {
  const heard = heardRepoPath();
  const anonKey = readLiveAnonKey();
  const host = resolveHost(process.argv.slice(2));
  const url = functionsUrl(host);

  // 1) .env.local (gitignored in Heard)
  const envPath = path.join(heard, ".env.local");
  let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  env = upsertEnv(env, "VITE_HEARD_ENV", "development");
  env = upsertEnv(env, "VITE_SUPABASE_FUNCTIONS_URL", url);
  env = upsertEnv(env, "VITE_SUPABASE_ANON_KEY", anonKey);
  env = upsertEnv(env, "VITE_HEARD_API_SECRET", HEARD_API_SECRET);
  writeFileSync(envPath, env);
  console.log(`wrote ${envPath}`);

  // 2) api-client.ts override (idempotent), kept out of git.
  const apiClientPath = path.join(heard, "src", "utils", "api-client.ts");
  let src = readFileSync(apiClientPath, "utf8");
  if (src.includes("VITE_SUPABASE_FUNCTIONS_URL")) {
    console.log("api-client.ts override already present");
  } else if (src.includes(ORIGINAL_LINE)) {
    src = src.replace(ORIGINAL_LINE, OVERRIDE_LINE);
    writeFileSync(apiClientPath, src);
    console.log("patched src/utils/api-client.ts");
  } else {
    console.warn(
      "!! Could not find the expected API_BASE_URL line in api-client.ts.\n" +
        "   Manually make API_BASE_URL fall back to import.meta.env.VITE_SUPABASE_FUNCTIONS_URL.",
    );
  }

  // 3) Hide the api-client.ts change from git so it is never committed.
  run("git update-index --skip-worktree src/utils/api-client.ts", { cwd: heard });
  console.log("git: api-client.ts marked --skip-worktree (won't show in status)");

  // 4) Inject the "staging backend" warning bar into main.tsx (idempotent), and
  // hide it from git too. Makes it obvious at a glance that the frontend is
  // pointed at this local stack rather than production.
  const mainPath = path.join(heard, "src", "main.tsx");
  let main = readFileSync(mainPath, "utf8");
  if (main.includes(STAGING_BANNER_BEGIN)) {
    console.log("main.tsx staging banner already present");
  } else {
    // Match the file's own line endings and leave the existing bytes untouched
    // (just append a blank line + the block) so `unwire:heard` can restore it
    // byte-for-byte and it never shows up as modified in git.
    const eol = main.includes("\r\n") ? "\r\n" : "\n";
    const sep = main.endsWith(eol) ? eol : eol + eol;
    main = main + sep + stagingBannerBlock(eol);
    writeFileSync(mainPath, main);
    console.log("injected staging banner into src/main.tsx");
  }
  run("git update-index --skip-worktree src/main.tsx", { cwd: heard });
  console.log("git: main.tsx marked --skip-worktree (won't show in status)");

  console.log(`\nHeard is wired to the local backend at ${url}`);
  if (host !== "127.0.0.1") {
    console.log(
      `LAN mode: start Heard with \`npm run dev -- --host\` and open http://${host}:3000 from other devices.\n` +
        "Ensure Windows Firewall allows inbound TCP 3000 and 54321.",
    );
  } else {
    console.log("Restart `npm run dev` in the Heard repo.");
  }
}

main();
