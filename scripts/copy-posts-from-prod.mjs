// Copy real posts (debate rooms) from the production Heard DB into the local
// staging stack — handy for populating staging with posts that already have lots
// of votes.
//
// In Heard, ~all app data lives in the `kv_store_f1a393b4` JSONB table. A "post"
// is a `room:<id>` row, its takes are `statement:<roomId>:<statementId>` rows,
// and the vote COUNTS the UI shows are recomputed live from individual
// `vote:<statementId>:<userId>` rows (see debate-api.tsx calculateVoteStats).
// So to reproduce a post's vote totals we copy room + statements + votes. We do
// NOT copy `user:` rows, so no emails/phones come across — only opaque user IDs
// embedded in the votes/authorship.
//
// Usage:
//   # 1) Discover — list the most-voted rooms in prod (read-only):
//   npm run copy:posts -- "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres"
//
//   # 2) Copy the ones you want into local + a re-usable seed file:
//   npm run copy:posts -- "postgresql://..." --rooms <roomId1>,<roomId2>
//
//   # 3) Re-apply the saved seed file later (e.g. after `npm run db:reset`) — no prod needed:
//   npm run seed:posts
//
// API mode (--via-api): pull from prod's edge function over HTTP using
// HEARD_API_SECRET instead of a DB connection string. The room endpoint returns
// each statement's `voters` map (userId -> voteType), which we use to rebuild the
// vote rows — with the voter IDs ANONYMIZED (synthetic IDs; counts/vote types are
// preserved exactly, no real user IDs reach staging). Discovery via the API is
// limited to the <=20 active rooms /rooms/active returns, but --rooms fetches any
// room by ID. Needs the prod function URL + HEARD_API_SECRET (+ the public anon
// key if the prod gateway enforces JWT):
//   HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api \
//     "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4" \
//     --anon-key <public-anon-key> --rooms <roomId1>,<roomId2>
//
// Flags:
//   --via-api       source from the prod HTTP API instead of a DB connection
//   --api-secret    HEARD_API_SECRET (or set it as an env var)   [api mode]
//   --anon-key      prod public anon key for the Bearer header   [api mode]
//   --rooms <csv>   room IDs to copy (copy mode)
//   --limit <n>     how many rooms to list in discover mode (default 20)
//   --no-activate   copy rooms verbatim instead of forcing them feed-visible
//   --apply         re-apply the existing seed file to local; ignore prod
//   --local <url>   override the local DB URL (default: from `supabase status`)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { ROOT, capture } from "./lib.mjs";

const SEED_FILE = path.join(ROOT, "supabase", "seed-prod-posts.sql");
const DEFAULT_LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    rooms: [], limit: 20, activate: true, apply: false, local: null, prodUrl: null,
    api: false, apiSecret: null, anonKey: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--via-api") opts.api = true;
    else if (a === "--no-activate") opts.activate = false;
    else if (a === "--rooms") opts.rooms = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--rooms=")) opts.rooms = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") opts.limit = parseInt(argv[++i], 10) || 20;
    else if (a === "--local") opts.local = argv[++i];
    else if (a.startsWith("--local=")) opts.local = a.slice(8);
    else if (a === "--api-secret") opts.apiSecret = argv[++i];
    else if (a.startsWith("--api-secret=")) opts.apiSecret = a.slice(13);
    else if (a === "--anon-key") opts.anonKey = argv[++i];
    else if (a.startsWith("--anon-key=")) opts.anonKey = a.slice(11);
    else if (!a.startsWith("--") && !opts.prodUrl) opts.prodUrl = a;
  }
  return opts;
}

// ── connection helpers ───────────────────────────────────────────────────────
function localDbUrl(override) {
  if (override) return override;
  const env = capture("npx supabase status -o env");
  const m = env && env.match(/^DB_URL="?([^"\n]+)"?/m);
  return m ? m[1] : DEFAULT_LOCAL_DB_URL;
}

function makeClient(connStr) {
  const isLocal = /(127\.0\.0\.1|localhost)/.test(connStr);
  // Supabase requires TLS; its cert chain isn't in Node's default store, so for a
  // throwaway read we skip verification. Local Postgres needs no TLS at all.
  return new pg.Client({ connectionString: connStr, ssl: isLocal ? false : { rejectUnauthorized: false } });
}

async function withClient(connStr, fn) {
  const client = makeClient(connStr);
  try {
    await client.connect();
  } catch (e) {
    throw new Error(`Could not connect to ${connStr.replace(/:\/\/[^@]*@/, "://***@")}\n  ${e.message}`);
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ── SQL building ─────────────────────────────────────────────────────────────
// kv keys: statement:<roomId>:<statementId>  /  vote:<statementId>:<userId>
function sqlInsertChunks(rows, chunkSize = 100) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const values = rows
      .slice(i, i + chunkSize)
      .map((r) => {
        const k = String(r.key).replace(/'/g, "''");
        const v = JSON.stringify(r.value).replace(/'/g, "''");
        return `  ('${k}', '${v}'::jsonb)`;
      })
      .join(",\n");
    chunks.push(
      `insert into kv_store_f1a393b4 (key, value) values\n${values}\non conflict (key) do update set value = excluded.value;`,
    );
  }
  return chunks.join("\n\n");
}

// Force a copied room to be browsable in staging's feed: active, not a test room,
// not tied to an event (mirrors the filters in debate-api getActiveRooms/getAllRealDebates).
function makeVisible(value) {
  return { ...value, isActive: true, isTestRoom: false, eventId: null };
}

// ── modes ────────────────────────────────────────────────────────────────────
async function discover(prodUrl, limit) {
  const sql = `
    SELECT split_part(s.key, ':', 2)                  AS room_id,
           left(coalesce(r.value->>'topic', '(no topic)'), 70) AS topic,
           count(DISTINCT s.key)                       AS statements,
           count(v.key)                                AS votes,
           coalesce(r.value->>'isActive', '?')         AS active,
           coalesce(r.value->>'isTestRoom', 'false')   AS test
    FROM kv_store_f1a393b4 s
    LEFT JOIN kv_store_f1a393b4 v
      ON v.key LIKE 'vote:%' AND split_part(v.key, ':', 2) = split_part(s.key, ':', 3)
    LEFT JOIN kv_store_f1a393b4 r
      ON r.key = 'room:' || split_part(s.key, ':', 2)
    WHERE s.key LIKE 'statement:%'
    GROUP BY 1, 2, 5, 6
    ORDER BY votes DESC
    LIMIT $1;`;
  const { rows } = await withClient(prodUrl, (c) => c.query(sql, [limit]));
  if (!rows.length) {
    console.log("No rooms with statements found in that database.");
    return;
  }
  console.log(`\nTop ${rows.length} most-voted posts in production:\n`);
  console.log("  votes  stmts  active  test   topic / room_id");
  console.log("  -----  -----  ------  -----  ----------------------------------------");
  for (const r of rows) {
    const votes = String(r.votes).padStart(5);
    const stmts = String(r.statements).padStart(5);
    const active = String(r.active).padEnd(6);
    const test = String(r.test).padEnd(5);
    console.log(`  ${votes}  ${stmts}  ${active}  ${test}  ${r.topic}`);
    console.log(`  ${" ".repeat(30)} ${r.room_id}`);
  }
  console.log(
    `\nCopy the ones you want:\n  npm run copy:posts -- "<prod-url>" --rooms ${rows.slice(0, 3).map((r) => r.room_id).join(",")}\n`,
  );
}

async function copyRooms(prodUrl, roomIds, activate) {
  const rows = await withClient(prodUrl, async (c) => {
    // rooms + their statements
    const roomKeys = roomIds.map((id) => `room:${id}`);
    const stmtPrefixes = roomIds.map((id) => `statement:${id}:%`);
    const base = await c.query(
      `SELECT key, value FROM kv_store_f1a393b4
       WHERE key = ANY($1::text[]) OR key LIKE ANY($2::text[])`,
      [roomKeys, stmtPrefixes],
    );

    // votes for those statements (statementId = 3rd segment of the statement key)
    const statementIds = base.rows
      .filter((r) => r.key.startsWith("statement:"))
      .map((r) => r.key.split(":")[2]);
    let voteRows = [];
    if (statementIds.length) {
      const votes = await c.query(
        `SELECT key, value FROM kv_store_f1a393b4
         WHERE key LIKE 'vote:%' AND split_part(key, ':', 2) = ANY($1::text[])`,
        [statementIds],
      );
      voteRows = votes.rows;
    }
    return [...base.rows, ...voteRows];
  });

  if (activate) {
    for (const r of rows) if (r.key.startsWith("room:")) r.value = makeVisible(r.value);
  }

  const found = new Set(rows.filter((r) => r.key.startsWith("room:")).map((r) => r.key.slice(5)));
  const missing = roomIds.filter((id) => !found.has(id));
  return { rows, missing };
}

function summarize(rows) {
  const counts = { room: 0, statement: 0, vote: 0 };
  for (const r of rows) {
    if (r.key.startsWith("room:")) counts.room++;
    else if (r.key.startsWith("statement:")) counts.statement++;
    else if (r.key.startsWith("vote:")) counts.vote++;
  }
  return counts;
}

async function applySeedFile(localUrl) {
  if (!existsSync(SEED_FILE)) {
    throw new Error(`No seed file at ${SEED_FILE}. Run \`npm run copy:posts\` first.`);
  }
  const sql = readFileSync(SEED_FILE, "utf8");
  await withClient(localUrl, (c) => c.query(sql));
  console.log(`Applied ${SEED_FILE} to ${localUrl.replace(/:\/\/[^@]*@/, "://***@")}`);
}

// Shared by both sources: write the gitignored seed file, then load it into local.
async function writeAndApply(rows, roomsLabel, opts, note = "") {
  const counts = summarize(rows);
  const header =
    "-- Posts copied from production by `npm run copy:posts`.\n" +
    `-- Rooms: ${roomsLabel}\n` +
    `-- ${counts.room} room(s), ${counts.statement} statement(s), ${counts.vote} vote(s).${note ? " " + note : ""}\n` +
    "-- Gitignored (real user content). Re-apply with `npm run seed:posts`.\n\n";
  writeFileSync(SEED_FILE, header + sqlInsertChunks(rows) + "\n");
  console.log(`> wrote ${SEED_FILE}`);
  try {
    await applySeedFile(localDbUrl(opts.local));
  } catch (e) {
    console.error(
      `\nWrote the seed file but couldn't apply it to local:\n  ${e.message}\n` +
        "Is the stack up (`npm run dev`)? You can re-apply anytime with `npm run seed:posts`.",
    );
    process.exit(1);
  }
  return counts;
}

// ── HTTP API source (uses HEARD_API_SECRET instead of a DB connection) ────────
function normalizeApiBase(url) {
  let u = url.replace(/\/+$/, "");
  if (!u.includes("/functions/v1/")) u += "/functions/v1/make-server-f1a393b4";
  return u;
}

async function apiGet(base, routePath, secret, anonKey) {
  const headers = { "X-API-Key": secret, "Content-Type": "application/json" };
  if (anonKey) headers["Authorization"] = `Bearer ${anonKey}`;
  const res = await fetch(`${base}${routePath}`, { headers });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && body.error) || res.statusText || `HTTP ${res.status}`;
    const hint =
      res.status === 401
        ? "\n  (401 — check HEARD_API_SECRET; if the prod gateway enforces JWT, also pass --anon-key / set SUPABASE_ANON_KEY.)"
        : "";
    throw new Error(`GET ${routePath} -> ${res.status} ${msg}${hint}`);
  }
  return body;
}

const totalVotesOf = (statements) =>
  statements.reduce(
    (n, s) => n + (s.agrees || 0) + (s.disagrees || 0) + (s.passes || 0) + (s.superAgrees || 0),
    0,
  );

// Run an async fn over items with bounded concurrency.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function discoverViaApi(base, secret, anonKey, limit) {
  const { rooms } = await apiGet(base, "/rooms/active", secret, anonKey);
  if (!rooms || !rooms.length) {
    console.log("No active rooms returned by /rooms/active.");
    return;
  }
  console.log(`> fetching vote totals for ${rooms.length} active room(s)...`);
  const detailed = await mapPool(rooms, 6, async (room) => {
    try {
      const { statements } = await apiGet(base, `/room/${room.id}`, secret, anonKey);
      return { id: room.id, topic: room.topic, statements: statements.length, votes: totalVotesOf(statements), active: room.isActive };
    } catch {
      return { id: room.id, topic: room.topic, statements: 0, votes: 0, active: room.isActive };
    }
  });
  detailed.sort((a, b) => b.votes - a.votes);
  const top = detailed.slice(0, limit);
  console.log(`\nMost-voted of the ${rooms.length} active rooms (the API caps /rooms/active at 20):\n`);
  console.log("  votes  stmts  active  topic / room_id");
  console.log("  -----  -----  ------  ----------------------------------------");
  for (const r of top) {
    console.log(`  ${String(r.votes).padStart(5)}  ${String(r.statements).padStart(5)}  ${String(r.active).padEnd(6)}  ${(r.topic || "(no topic)").slice(0, 60)}`);
    console.log(`  ${" ".repeat(21)} ${r.id}`);
  }
  console.log(
    `\nCopy the ones you want:\n  npm run copy:posts -- --via-api "<prod-url>" --rooms ${top.slice(0, 3).map((r) => r.id).join(",")}\n`,
  );
}

async function copyRoomsViaApi(base, secret, anonKey, roomIds, activate) {
  // Stable real-userId -> synthetic-id mapping, reused across every field/row so a
  // given person stays one consistent "anon-N" (preserves author/voter/host
  // relationships) while no real user ID ever reaches staging.
  const anonMap = new Map();
  const anonIdFor = (realId) => {
    if (realId == null) return realId;
    if (!anonMap.has(realId)) anonMap.set(realId, `anon-${anonMap.size + 1}`);
    return anonMap.get(realId);
  };
  // Scrub the user-ID-bearing fields on rooms/statements (per the DebateRoom /
  // Statement types). Other fields (topic, text, ...) are left as-is.
  const anonRoom = (room) => {
    const r = { ...room };
    if (r.hostId != null) r.hostId = anonIdFor(r.hostId);
    if (Array.isArray(r.participants)) r.participants = r.participants.map(anonIdFor);
    if (r.responsesPausedBy != null) r.responsesPausedBy = anonIdFor(r.responsesPausedBy);
    return r;
  };
  const anonStatement = (statement) => {
    const s = { ...statement };
    if (s.author != null) s.author = anonIdFor(s.author);
    if (s.hiddenBy != null) s.hiddenBy = anonIdFor(s.hiddenBy);
    return s;
  };

  const rows = [];
  const missing = [];
  for (const roomId of roomIds) {
    let data;
    try {
      data = await apiGet(base, `/room/${roomId}`, secret, anonKey);
    } catch (e) {
      console.warn(`!! ${roomId}: ${e.message}`);
      missing.push(roomId);
      continue;
    }
    if (!data || !data.room) {
      missing.push(roomId);
      continue;
    }
    let room = anonRoom(data.room);
    if (activate) room = makeVisible(room);
    rows.push({ key: `room:${roomId}`, value: room });
    for (const s of data.statements || []) {
      const { voters, ...statement } = s; // drop the computed voters map; keep the stored shape
      rows.push({ key: `statement:${roomId}:${s.id}`, value: anonStatement(statement) });
      for (const [realUserId, voteType] of Object.entries(voters || {})) {
        const uid = anonIdFor(realUserId);
        rows.push({
          key: `vote:${s.id}:${uid}`,
          value: { id: `v-${s.id}-${uid}`, statementId: s.id, userId: uid, voteType, timestamp: s.timestamp || 0 },
        });
      }
    }
  }
  return { rows, missing, anonCount: anonMap.size };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Re-apply the existing seed file to local; no prod connection.
  if (opts.apply) {
    await applySeedFile(localDbUrl(opts.local));
    return;
  }

  // ── API source: pull over HTTP with HEARD_API_SECRET ──
  if (opts.api) {
    const secret = opts.apiSecret || process.env.HEARD_API_SECRET;
    const anonKey = opts.anonKey || process.env.SUPABASE_ANON_KEY || process.env.PROD_ANON_KEY || null;
    if (!opts.prodUrl) {
      console.error(
        "Provide the production function URL:\n" +
          '  HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4"\n' +
          "Add --rooms <id1,id2> to copy specific rooms; omit it to list the most-voted active ones.",
      );
      process.exit(1);
    }
    if (!secret) {
      console.error("Set the production HEARD_API_SECRET as an env var, or pass --api-secret <key>.");
      process.exit(1);
    }
    const base = normalizeApiBase(opts.prodUrl);

    if (!opts.rooms.length) {
      await discoverViaApi(base, secret, anonKey, opts.limit);
      return;
    }

    console.log(`> reading ${opts.rooms.length} room(s) from the production API...`);
    const { rows, missing, anonCount } = await copyRoomsViaApi(base, secret, anonKey, opts.rooms, opts.activate);
    if (missing.length) console.warn(`!! could not fetch: ${missing.join(", ")}`);
    if (!rows.length) {
      console.error("Nothing to copy. Check the room IDs (run --via-api with no --rooms to list candidates).");
      process.exit(1);
    }
    const counts = await writeAndApply(rows, opts.rooms.join(", "), opts, `All user IDs anonymized (${anonCount} synthetic users).`);
    console.log(
      `\nDone — ${counts.room} post(s) with ${counts.vote} anonymized votes are now in your local stack.` +
        (opts.activate ? " (copied rooms were set active + feed-visible)" : "") +
        "\nReload the staging frontend to see them.",
    );
    return;
  }

  // ── DB source: copy rows directly from prod Postgres ──
  if (!opts.prodUrl) {
    console.error(
      "Provide the production DB URL:\n" +
        '  npm run copy:posts -- "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres"\n' +
        "(Supabase dashboard → Project Settings → Database → Connection string.)\n" +
        "Add --rooms <id1,id2> to copy specific rooms; omit it to list the most-voted ones.\n" +
        "No DB string? Use --via-api with HEARD_API_SECRET instead (see the header comment).",
    );
    process.exit(1);
  }

  // Discover mode: no --rooms given.
  if (!opts.rooms.length) {
    await discover(opts.prodUrl, opts.limit);
    return;
  }

  // Copy mode.
  console.log(`> reading ${opts.rooms.length} room(s) from production...`);
  const { rows, missing } = await copyRooms(opts.prodUrl, opts.rooms, opts.activate);
  if (missing.length) console.warn(`!! no room: row found for: ${missing.join(", ")}`);
  if (!rows.length) {
    console.error("Nothing to copy. Check the room IDs (run discover mode to list them).");
    process.exit(1);
  }
  const counts = await writeAndApply(rows, opts.rooms.join(", "), opts);
  console.log(
    `\nDone — ${counts.room} post(s) with ${counts.vote} votes are now in your local stack.` +
      (opts.activate ? " (copied rooms were set active + feed-visible)" : "") +
      "\nReload the staging frontend to see them.",
  );
}

main().catch((e) => {
  console.error("\n" + (e?.message || e) + "\n");
  process.exit(1);
});
