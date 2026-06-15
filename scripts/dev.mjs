// `npm run dev` — bring up the local artificial Supabase backend for Heard.
//
//   1. verify Docker is running
//   2. sync Heard's function source + migrations into this project
//   3. `supabase start` (Postgres + Auth + Storage + edge runtime, in Docker)
//   4. `supabase functions serve` the Heard edge function (foreground, hot-reload)
//
// Ctrl+C stops the function server but leaves the database stack running for fast
// restarts. Run `npm run stop` to tear the whole stack down.
import { existsSync, copyFileSync } from "node:fs";
import { run, dockerIsRunning, FUNCTION_NAME, LOCAL_FUNCTIONS_URL } from "./lib.mjs";
import { syncFromHeard } from "./sync-from-heard.mjs";

if (!dockerIsRunning()) {
  console.error(
    "\n  Docker isn't responding.\n" +
      "  Start Docker Desktop (wait until the whale icon says 'running'), then retry `npm run dev`.\n",
  );
  process.exit(1);
}

const FUNCTION_ENV = "./supabase/functions/.env";
if (!existsSync(FUNCTION_ENV)) {
  const example = FUNCTION_ENV + ".example";
  if (!existsSync(example)) {
    console.error(`\n  ${FUNCTION_ENV} and ${example} are both missing — can't serve the function.\n`);
    process.exit(1);
  }
  copyFileSync(example, FUNCTION_ENV);
  console.log(
    `> created ${FUNCTION_ENV} from .env.example.\n` +
      "  Works out of the box except for AI features — add a provider key\n" +
      "  (e.g. GEMINI_API_KEY=...) to that file to enable the LLM-backed paths.\n",
  );
}

console.log("> syncing backend code from the Heard repo...");
syncFromHeard();

console.log("\n> starting the Supabase stack (first run pulls images; be patient)...");
if (run("npx supabase start") !== 0) {
  console.error("\n  `supabase start` failed. See the output above.\n");
  process.exit(1);
}

console.log(
  "\n" +
    "  ┌──────────────────────────────────────────────────────────────────────┐\n" +
    "  │  Heard staging backend is UP                                           │\n" +
    "  ├──────────────────────────────────────────────────────────────────────┤\n" +
    `  │  Function URL : ${LOCAL_FUNCTIONS_URL}\n` +
    "  │  Studio       : http://127.0.0.1:54323\n" +
    "  │  Postgres     : postgres://postgres:postgres@127.0.0.1:54322/postgres\n" +
    "  │\n" +
    "  │  Point Heard at it:  (in the heard-staging dir)  npm run wire:heard\n" +
    "  │  Then run Heard:     (in the heard dir)          npm run dev\n" +
    "  └──────────────────────────────────────────────────────────────────────┘\n",
);

console.log(`> serving the ${FUNCTION_NAME} function (Ctrl+C to stop)...\n`);
const code = run("npx supabase functions serve " + FUNCTION_NAME + " --env-file ./supabase/functions/.env");
process.exit(code);
