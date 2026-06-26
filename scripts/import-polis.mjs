// Import sample Polis conversations into the local staging stack as Heard posts
// (debate rooms) — handy for testing "Ask the data" and other features that need
// rooms with lots of statements + clustered votes.
//
// It drives Heard's own `/import-polis` endpoint, which builds dummy test users,
// imports the room/statements/votes, AND recomputes opinion clusters. We just
// feed it CSVs in the shape its parser wants and create a public community so the
// imported rooms show up in the feed.
//
// Source: the Computational Democracy Project's open datasets
// (https://github.com/compdemocracy/openData) — real Polis conversations.
//
// Usage:
//   npm run dev                              # local stack must be running
//   npm run import:polis -- brexit-consensus
//   npm run import:polis -- american-assembly.bowling-green scoop-hivemind.biodiversity
//   npm run import:polis -- brexit-consensus --dry-run     # preview counts, import nothing
//   npm run import:polis -- --from ./my-convo --name "My Topic"   # local comments.csv + participants-votes.csv
//
// Flags:
//   --subheard <name>   community to file the rooms under (default: polis-samples)
//   --name <title>      debate title (single conversation only; else derived from the slug)
//   --from <dir>        read comments.csv + participants-votes.csv from a local dir instead of fetching
//   --max-participants  cap participants per room (default 1000; the endpoint caps at 1000 too)
//   --dry-run           ask the endpoint to validate + report counts without importing
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import pg from "pg";
import { ROOT, LOCAL_FUNCTIONS_URL, DEFAULT_LOCAL_ANON_KEY, capture } from "./lib.mjs";

const OPENDATA_RAW = "https://raw.githubusercontent.com/compdemocracy/openData/master";
const IMPORTER_ID = "polis-importer";
const DEFAULT_LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  // Defaults keep the participants x statements matrix small enough that the
  // endpoint's clustering step fits inside the edge runtime's resource limits
  // (bigger imports return HTTP 546). Raise them per-dataset if you want.
  const o = { convos: [], subHeard: "polis-samples", name: null, from: null, dryRun: false, maxParticipants: 300, maxStatements: 80 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--subheard") o.subHeard = argv[++i];
    else if (a.startsWith("--subheard=")) o.subHeard = a.slice(11);
    else if (a === "--name") o.name = argv[++i];
    else if (a.startsWith("--name=")) o.name = a.slice(7);
    else if (a === "--from") o.from = argv[++i];
    else if (a.startsWith("--from=")) o.from = a.slice(7);
    else if (a === "--max-participants") o.maxParticipants = parseInt(argv[++i], 10) || 300;
    else if (a === "--max-statements") o.maxStatements = parseInt(argv[++i], 10) || 80;
    else if (!a.startsWith("--")) o.convos.push(a);
  }
  return o;
}

const prettyName = (slug) =>
  (slug.includes(".") ? slug.split(".").pop() : slug)
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");

// ── CSV source ───────────────────────────────────────────────────────────────
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.text();
}

async function loadConvo(convo, fromDir) {
  if (fromDir) {
    const c = path.join(fromDir, "comments.csv");
    const v = path.join(fromDir, "participants-votes.csv");
    if (!existsSync(c) || !existsSync(v)) {
      throw new Error(`Expected comments.csv + participants-votes.csv in ${fromDir}`);
    }
    return { comments: readFileSync(c, "utf8"), votes: readFileSync(v, "utf8") };
  }
  const [comments, votes] = await Promise.all([
    fetchText(`${OPENDATA_RAW}/${convo}/comments.csv`),
    fetchText(`${OPENDATA_RAW}/${convo}/participants-votes.csv`),
  ]);
  return { comments, votes };
}

// Reindex Polis CSVs into the positional shape Heard's parser expects: statement
// row i must line up with vote-matrix column i. Real openData lists comments in
// reverse comment-id order and the vote matrix is keyed by comment-id, so we sort
// kept comments by comment-id and rebuild the matrix against the new 0..K-1 index.
function buildHeardCsvs(commentsCsv, votesCsv, { maxParticipants, maxStatements }) {
  const parse = (csv) =>
    Papa.parse(csv, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() }).data;

  let kept = parse(commentsCsv)
    .map((r) => ({
      commentId: parseInt(r["comment-id"], 10),
      authorId: parseInt(r["author-id"], 10),
      body: (r["comment-body"] || "").trim(),
      moderated: r["moderated"],
      engagement: (parseInt(r["agrees"], 10) || 0) + (parseInt(r["disagrees"], 10) || 0),
    }))
    .filter((c) => Number.isInteger(c.commentId) && c.body && c.moderated !== "-1"); // drop rejected/empty

  if (!kept.length) throw new Error("No usable comments found.");

  // Keep the most-voted statements when capping, so the clustering has signal.
  if (maxStatements && kept.length > maxStatements) {
    kept = [...kept].sort((a, b) => b.engagement - a.engagement).slice(0, maxStatements);
  }
  kept.sort((a, b) => a.commentId - b.commentId); // stable order (reindex below keeps votes aligned)

  const statementsCSV = Papa.unparse({
    fields: ["author-id", "comment-body"],
    data: kept.map((c) => ({ "author-id": c.authorId, "comment-body": c.body })),
  });

  const K = kept.length;
  const newIndexByCommentId = new Map(kept.map((c, i) => [c.commentId, i]));
  const fields = ["participant", ...Array.from({ length: K }, (_, j) => String(j))];

  const voteRows = parse(votesCsv)
    .slice(0, maxParticipants)
    .map((row) => {
      const out = { participant: row["participant"] };
      for (let j = 0; j < K; j++) out[String(j)] = "";
      for (const c of kept) {
        const v = row[String(c.commentId)];
        if (v === "1" || v === "-1" || v === "0") out[String(newIndexByCommentId.get(c.commentId))] = v;
      }
      return out;
    });

  const votesCSV = Papa.unparse({ fields, data: voteRows });
  return { statementsCSV, votesCSV, statementCount: K, participantCount: voteRows.length };
}

// ── local endpoint auth ──────────────────────────────────────────────────────
function localSecret() {
  const envPath = path.join(ROOT, "supabase", "functions", ".env");
  if (existsSync(envPath)) {
    const m = readFileSync(envPath, "utf8").match(/^HEARD_API_SECRET=(.*)$/m);
    if (m) return m[1].trim();
  }
  return "heard-local-dev-secret";
}

async function localFetch(routePath, { method = "GET", body, sessionId, secret } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "X-API-Key": secret,
    Authorization: `Bearer ${DEFAULT_LOCAL_ANON_KEY}`,
  };
  if (sessionId) headers["X-Session-Id"] = sessionId;
  const res = await fetch(`${LOCAL_FUNCTIONS_URL}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${routePath} -> ${res.status} ${(parsed && parsed.error) || res.statusText}`);
  }
  return parsed;
}

async function bootstrapSession(secret) {
  const res = await localFetch("/user/anonymous", {
    method: "POST",
    secret,
    body: { environment: "polis-import", fingerprint: "polis-import", userAgent: "polis-import", webdriver: false },
  });
  if (!res || !res.sessionId) throw new Error("Could not create a local anonymous session.");
  return res.sessionId;
}

function localDbUrl() {
  const env = capture("npx supabase status -o env");
  const m = env && env.match(/^DB_URL="?([^"\n]+)"?/m);
  return m ? m[1] : DEFAULT_LOCAL_DB_URL;
}

// The feed hides rooms whose community is missing/private, so make the target
// community exist and be public (matches the copy:posts behaviour).
async function ensurePublicCommunity(name) {
  const client = new pg.Client({ connectionString: localDbUrl(), ssl: false });
  await client.connect();
  try {
    await client.query(
      "insert into kv_store_f1a393b4(key,value) values($1,$2::jsonb) on conflict(key) do nothing",
      [`subheard:${name}`, JSON.stringify({ name, adminId: "staging-seed", isPrivate: false, hostOnlyPosting: false })],
    );
  } finally {
    await client.end();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = opts.from ? [opts.from] : opts.convos;
  if (!jobs.length) {
    console.error(
      "Name at least one Polis conversation (or use --from <dir>):\n" +
        "  npm run import:polis -- brexit-consensus\n" +
        "Browse conversations at https://github.com/compdemocracy/openData",
    );
    process.exitCode = 1;
    return;
  }
  if (opts.name && jobs.length > 1) {
    console.error("--name applies to a single conversation only; omit it for multiple.");
    process.exitCode = 1;
    return;
  }

  const secret = localSecret();
  const sessionId = await bootstrapSession(secret);
  const imported = [];

  for (const job of jobs) {
    const label = opts.from ? path.basename(path.resolve(job)) : job;
    const debateName = opts.name || prettyName(label);
    console.log(`\n> ${opts.dryRun ? "validating" : "importing"} "${debateName}" (${label})...`);
    try {
      const { comments, votes } = await loadConvo(job, opts.from);
      const { statementsCSV, votesCSV, statementCount, participantCount } = buildHeardCsvs(comments, votes, {
        maxParticipants: opts.maxParticipants,
        maxStatements: opts.maxStatements,
      });
      console.log(`  prepared ${statementCount} statements x ${participantCount} participants`);

      const res = await localFetch("/import-polis", {
        method: "POST",
        secret,
        sessionId,
        body: {
          debateName,
          subHeard: opts.subHeard,
          statementsCSV,
          votesCSV,
          importerId: IMPORTER_ID,
          dryRun: opts.dryRun,
        },
      });

      if (opts.dryRun) {
        console.log(
          `  [dry run] users=${res.summary.userCount} statements=${res.summary.statementCount} ` +
            `votes=${res.summary.voteCount} avgVotes/stmt=${res.summary.avgVotesPerStatement}`,
        );
        if (res.voteDistribution) console.log(`  votes:`, JSON.stringify(res.voteDistribution));
        if (res.warnings?.length) res.warnings.forEach((w) => console.warn(`  ! ${w}`));
      } else {
        console.log(`  imported room ${res.roomId} — ${res.statementCount} statements, ${res.voteCount} votes`);
        imported.push({ debateName, roomId: res.roomId, votes: res.voteCount });
      }
    } catch (e) {
      console.error(`  !! failed: ${e.message}`);
    }
  }

  if (!opts.dryRun && imported.length) {
    await ensurePublicCommunity(opts.subHeard);
    console.log(`\nDone — imported ${imported.length} post(s) into the public "${opts.subHeard}" community:`);
    for (const r of imported) console.log(`  - ${r.debateName} (${r.votes} votes) — room ${r.roomId}`);
    console.log("Reload the staging frontend to see them.");
  } else if (opts.dryRun) {
    console.log("\nDry run complete — nothing was imported.");
  } else {
    console.error("\nNothing was imported.");
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("\n" + (e?.message || e) + "\n");
  process.exitCode = 1;
});
