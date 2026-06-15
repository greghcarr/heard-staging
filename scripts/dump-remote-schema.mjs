// Capture the AUTHORITATIVE production schema to replace the hand-derived base
// schema. Use this once you have the production DB connection string, so the
// ad-hoc tables (presences, user_reports, demographic_*, events, ...) match prod
// exactly instead of being inferred from TypeScript types.
//
// Usage:
//   node scripts/dump-remote-schema.mjs "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres"
//
// It writes supabase/migrations/00000000000000_base_schema.sql. Review the diff
// before relying on it, and drop any objects the synced Heard migrations also
// create (votes, llm_api_calls, flyer_scans, phone_submissions, statement_merges,
// user_events) to avoid duplicate-create errors.
import path from "node:path";
import { ROOT, run } from "./lib.mjs";

const dbUrl = process.argv[2];
if (!dbUrl) {
  console.error('Provide the production DB URL: node scripts/dump-remote-schema.mjs "postgresql://..."');
  process.exit(1);
}

const out = path.join(ROOT, "supabase", "migrations", "00000000000000_base_schema.sql");
const code = run(
  `npx supabase db dump --db-url "${dbUrl}" --schema public -f "${out}"`,
);
if (code === 0) {
  console.log(`\nWrote ${out}. Review it, then trim tables the Heard migrations already create.`);
}
process.exit(code);
