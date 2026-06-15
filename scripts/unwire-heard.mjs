// Revert the Heard-side wiring: restore the original api-client.ts line, stop
// hiding it from git, and comment out the local-backend vars in .env.local so
// Heard talks to the cloud backend again.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { heardRepoPath, run } from "./lib.mjs";

const ORIGINAL_LINE =
  "export const API_BASE_URL = `https://${projectId}.supabase.co/functions/v1/make-server-f1a393b4`;";
const OVERRIDE_LINE =
  "export const API_BASE_URL = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL || `https://${projectId}.supabase.co/functions/v1/make-server-f1a393b4`;";

const LOCAL_KEYS = [
  "VITE_SUPABASE_FUNCTIONS_URL",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_HEARD_API_SECRET",
];

function main() {
  const heard = heardRepoPath();

  // 1) Restore api-client.ts.
  const apiClientPath = path.join(heard, "src", "utils", "api-client.ts");
  let src = readFileSync(apiClientPath, "utf8");
  if (src.includes(OVERRIDE_LINE)) {
    src = src.replace(OVERRIDE_LINE, ORIGINAL_LINE);
    writeFileSync(apiClientPath, src);
    console.log("restored src/utils/api-client.ts");
  }

  // 2) Stop hiding it from git.
  run("git update-index --no-skip-worktree src/utils/api-client.ts", { cwd: heard });
  console.log("git: api-client.ts no longer --skip-worktree");

  // 3) Comment out the local vars in .env.local so prod values (if any) win.
  const envPath = path.join(heard, ".env.local");
  if (existsSync(envPath)) {
    let env = readFileSync(envPath, "utf8");
    for (const key of LOCAL_KEYS) {
      env = env.replace(new RegExp(`^(${key}=.*)$`, "m"), "# $1  # disabled by unwire:heard");
    }
    writeFileSync(envPath, env);
    console.log(`commented local vars in ${envPath}`);
  }

  console.log("\nHeard is back on the cloud backend. Restart `npm run dev` in the Heard repo.");
}

main();
