// Mirror the Heard repo's edge-function source and committed migrations into this
// project so the local Supabase stack runs Heard's REAL backend code unmodified.
// Heard stays the single source of truth; nothing here is hand-maintained.
//
// This mirrors what Heard's own deploy-server.sh does: copy the server folder and
// add an index.ts entrypoint alongside the original index.tsx.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { ROOT, FUNCTION_NAME, heardRepoPath } from "./lib.mjs";

const BASE_MIGRATION = "00000000000000_base_schema.sql";

export function syncFromHeard() {
  const heard = heardRepoPath();

  // 1) Edge function source -> supabase/functions/make-server-f1a393b4
  const fnSrc = path.join(heard, "src", "supabase", "functions", "server");
  const fnDest = path.join(ROOT, "supabase", "functions", FUNCTION_NAME);
  rmSync(fnDest, { recursive: true, force: true });
  mkdirSync(fnDest, { recursive: true });
  cpSync(fnSrc, fnDest, { recursive: true });
  // Supabase serves index.ts as the entrypoint; Heard's entry is index.tsx.
  const indexTsx = path.join(fnDest, "index.tsx");
  if (existsSync(indexTsx)) {
    writeFileSync(path.join(fnDest, "index.ts"), readFileSync(indexTsx));
  }

  // 2) Committed migrations -> supabase/migrations (keep our base schema).
  const migSrc = path.join(heard, "supabase", "migrations");
  const migDest = path.join(ROOT, "supabase", "migrations");
  mkdirSync(migDest, { recursive: true });
  for (const f of readdirSync(migDest)) {
    if (f !== BASE_MIGRATION && f.endsWith(".sql")) {
      rmSync(path.join(migDest, f), { force: true });
    }
  }
  // Supabase's local migration runner keys schema_migrations on the leading
  // numeric version, so two Heard migrations sharing a timestamp (e.g. the two
  // 20260417000000 files) collide on a fresh apply. Bump duplicates to the next
  // free version as we copy — keeps Heard untouched, preserves order.
  let copied = 0;
  let renamed = 0;
  const seenVersions = new Set(["00000000000000"]); // our base schema
  if (existsSync(migSrc)) {
    const files = readdirSync(migSrc).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      let dest = f;
      const m = f.match(/^(\d+)_(.*)$/);
      if (m) {
        let version = m[1];
        if (seenVersions.has(version)) {
          let v = BigInt(version);
          do {
            v += 1n;
          } while (seenVersions.has(v.toString().padStart(version.length, "0")));
          version = v.toString().padStart(m[1].length, "0");
          dest = `${version}_${m[2]}`;
          renamed++;
        }
        seenVersions.add(version);
      }
      cpSync(path.join(migSrc, f), path.join(migDest, dest));
      copied++;
    }
  }

  console.log(
    `synced: ${FUNCTION_NAME} function source + ${copied} Heard migration(s)` +
      (renamed ? ` (${renamed} re-versioned to avoid collisions)` : "") +
      ` from ${heard}`,
  );
}

// Run when invoked directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("sync-from-heard.mjs")) {
  syncFromHeard();
}
