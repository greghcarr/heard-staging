# heard-staging

A local **artificial Supabase backend** for the [Heard](../heard) app — a self-contained staging environment that runs on this computer instead of a second cloud Supabase project.

It runs Heard's **real** edge function (`make-server-f1a393b4`) unmodified against a local Supabase stack (Postgres + Auth + Storage + edge runtime), all in Docker via the Supabase CLI. Heard's repo stays the single source of truth: this project *syncs* Heard's function code and migrations on every `npm run dev` and keeps **zero** Heard code committed here.

Flipping Heard between the cloud backend and this one is a single command (`npm run wire:heard` / `npm run unwire:heard`), and the only changes it makes inside the Heard repo are two uncommitted edits (`api-client.ts` + a `main.tsx` staging banner) and a gitignored `.env.local` — all reverted byte-for-byte by `unwire:heard`.

When wired to this backend, Heard shows a fixed **"⚠ STAGING BACKEND"** warning bar across the top of every screen, so it's never mistaken for production. See [Staging banner](#staging-banner) below.

## Prerequisites

- **Docker Desktop** running.
- **Node 18+** (uses `fs.cpSync`).
- The Heard repo checked out as a sibling directory named `heard` (or set `HEARD_REPO_PATH`, see `.env.example`).

The Supabase CLI is a dev dependency here — no global install needed.

## Quick start

A step-by-step from a fresh clone to viewing Heard running against this local backend.

### First-time setup (once)

1. Make sure **Docker Desktop is running**, you have **Node 18+**, and the [Heard repo](../heard) is checked out as a sibling `heard/` folder (see [Prerequisites](#prerequisites)).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create the function's secrets file. It's gitignored, and the local-dev `HEARD_API_SECRET` / `CRON_SECRET` are pre-filled so it works as-is. Add `GEMINI_API_KEY=…` only if you want the AI features (e.g. the GGWash importer):
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env
   ```

### Start the backend and see it in the Heard frontend

4. **Terminal 1 (this repo)** — start the local backend and leave it running. This syncs Heard's code, boots the Supabase stack, and serves the function:
   ```bash
   npm run dev
   ```
   Wait for the **`Heard staging backend is UP`** banner.
5. **Terminal 2 (this repo)** — point the Heard frontend at the local backend, then start it:
   ```bash
   npm run wire:heard           # writes Heard's .env.local + patches api-client.ts (hidden from git)
   cd ../heard && npm run dev   # starts the Heard frontend
   ```
6. Open **http://localhost:3000** — Heard now talks to your **local artificial backend** instead of the cloud.

### When you're done

7. Stop the Heard frontend (`Ctrl+C` in Terminal 2), then back in this repo revert the wiring and tear the stack down:
   ```bash
   npm run unwire:heard   # point Heard back at the cloud
   npm run stop           # stop the local Supabase stack
   ```

> To run Heard on **other devices** (phone, another computer), see [LAN access](#lan-access-use-heard-from-other-computersphones) below.

## LAN access (use Heard from other computers/phones)

`127.0.0.1` resolves to each visitor's *own* machine, so for LAN access the frontend must point at this host's LAN IP, and Vite must bind all interfaces.

```bash
npm run wire:heard -- --host lan        # auto-detects the LAN IP (or: --host 192.168.1.160)
cd ../heard && npm run dev -- --host    # Vite prints a "Network:" URL
```

Other devices then open `http://<LAN-IP>:3000` (Heard's Vite config pins port 3000). The local Supabase stack already binds `0.0.0.0`, so its API on `:54321` is reachable too.

- **Firewall:** allow inbound TCP **3000** and **54321** (rules named `Heard dev` / `Heard staging` were added for the Private profile).
- **IP changed (DHCP)?** Re-run `npm run wire:heard -- --host lan`.
- **Back to host-only:** `npm run wire:heard` (no flag) → `127.0.0.1`.
- **Secure-context caveat:** browsers block microphone/camera (`getUserMedia`) over plain HTTP on a LAN IP, so Heard's audio "rant" feature won't work on other devices without HTTPS. `localhost` on this host is exempt.

## What `npm run dev` does

1. Checks Docker is up.
2. **Syncs** `heard/src/supabase/functions/server` → `supabase/functions/make-server-f1a393b4` (adds the `index.ts` entrypoint, mirroring Heard's `deploy-server.sh`) and copies `heard/supabase/migrations/*.sql` in.
3. `supabase start` — Postgres, Auth (GoTrue), Storage, and the edge runtime.
4. `supabase functions serve make-server-f1a393b4` with the secrets in `supabase/functions/.env`.

`Ctrl+C` stops the function server; the database stack keeps running for fast restarts. `npm run stop` tears it all down.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Sync + start stack + serve the function |
| `npm run sync` | Just re-sync Heard's code/migrations |
| `npm run stop` | Stop the whole Supabase stack |
| `npm run status` | Show local URLs and keys |
| `npm run db:reset` | Drop & recreate the DB, re-run migrations + `seed.sql` |
| `npm run wire:heard` | Point Heard at this backend (writes `.env.local`, patches `api-client.ts`, injects the [staging banner](#staging-banner) into `main.tsx`, hides both from git) |
| `npm run unwire:heard` | Revert the Heard-side wiring (restores `api-client.ts` + `main.tsx` byte-for-byte) |
| `npm run dump:remote` | Capture the authoritative prod schema (see below) |
| `npm run copy:posts` | Copy real posts (with their votes) from prod into local ([see below](#copying-posts-from-production)) |
| `npm run seed:posts` | Re-apply the copied posts to local (e.g. after `db:reset`) — no prod needed |

## Copying posts from production

To populate staging with real posts that already have lots of votes, `copy:posts` pulls them straight from the production DB. In Heard, a "post" is a debate room: `room:<id>` plus its `statement:<roomId>:*` takes, all in the `kv_store_f1a393b4` JSONB table. The vote counts the UI shows are **recomputed live from individual `vote:<statementId>:*` rows**, so the script copies room + statements + votes together (copying only the room would show zero votes). It does **not** copy `user:` rows — no emails/phones come across, only the opaque user IDs already embedded in votes/authorship.

You need a **read-only production DB connection string** (Supabase dashboard → Project Settings → Database → Connection string). Run it in your own terminal so the credential never touches this repo:

```bash
# 1) See the most-voted posts in prod (read-only):
npm run copy:posts -- "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres"

# 2) Copy the ones you want — writes a gitignored seed file AND loads them into local:
npm run copy:posts -- "postgresql://..." --rooms <roomId1>,<roomId2>

# 3) Later (e.g. after `npm run db:reset`) re-apply them — no prod connection needed:
npm run seed:posts
```

- The copied rows land in **`supabase/seed-prod-posts.sql`** (gitignored — it's real user content). `seed:posts` re-applies that file, so your posts survive a DB reset without re-hitting prod.
- Copied rooms are forced **feed-visible** (`isActive: true`, not a test/event room) so they show up in staging. Pass `--no-activate` to copy them verbatim instead.
- The local stack must be running (`npm run dev`) for the apply step. Requires the `pg` dev dependency (installed via `npm install`).

### Without a DB connection string (`--via-api`)

If you don't have the Postgres connection string but do have the production **`HEARD_API_SECRET`**, `--via-api` pulls the same posts over HTTP from prod's edge function instead. It calls `/rooms/active` and `/room/:id` (the room endpoint returns each statement's `voters` map, which is enough to rebuild the votes). Pass the prod **function URL** and the secret (env var keeps it off the command line); add the public anon key if the prod gateway enforces JWT:

```bash
# Discover (lists the most-voted active rooms):
HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api \
  "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4" --anon-key <public-anon-key>

# Copy specific rooms:
HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api \
  "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4" --anon-key <public-anon-key> \
  --rooms <roomId1>,<roomId2>
```

- **All user IDs are anonymized** in this mode — voters, statement authors, room host/participants are replaced with stable synthetic `anon-N` IDs (counts and vote types are preserved exactly). No real user IDs reach staging, unlike the DB-string mode which copies them verbatim.
- **Discovery is capped at the ~20 active rooms** `/rooms/active` returns; `--rooms <ids>` can still copy *any* room by ID (active or ended). Same gitignored seed file + `seed:posts` re-apply as above.

## Staging banner

So a staging frontend is never mistaken for production, `wire:heard` injects a fixed warning bar — **⚠ STAGING BACKEND · `<host>` — not production data** — across the top of every Heard screen. `unwire:heard` removes it.

- **How it's injected:** a small self-contained block is appended to Heard's `src/main.tsx` (and hidden via `git update-index --skip-worktree`, exactly like the `api-client.ts` override). It's plain DOM — no React/JSX or Heard CSS dependencies — so it survives changes to Heard's component tree. `unwire:heard` strips it and restores `main.tsx` byte-for-byte, so it never appears in `git status`.
- **What triggers it:** the bar renders only when `import.meta.env.VITE_SUPABASE_FUNCTIONS_URL` is set, which is the env var `wire:heard` writes to point Heard at this stack. So it shows up **iff** the frontend is talking to this local backend — and shows the actual host (`127.0.0.1:54321` or your LAN IP).
- **Removing it manually:** if you ever need to, just delete the block between the `/* heard-staging:banner:begin … */` and `/* heard-staging:banner:end */` markers in `main.tsx`, or run `npm run unwire:heard`.

## Schema

- **`supabase/migrations/00000000000000_base_schema.sql`** (committed, ours) creates the tables that have **no migration in Heard**: the KV store `kv_store_f1a393b4`, `cover_card_swipes`, `room_follows`, `room_views`, `presences`, `user_reports`, `demographic_questions`, `demographic_answers`, `events`, `internal_vars`, `flyer_emails`, `org_signups`. These shapes are derived from Heard's TypeScript types.
- Heard's own committed migrations (`votes`, `llm_api_calls`, `flyer_scans`, `phone_submissions`, `statement_merges`, `user_events`, the `user_reports.reason` column) are **synced in** and run afterward.
- The image bucket `make-f1a393b4-debate-images` is created by the function itself on first upload.

### Making the schema authoritative

The base schema is a best-effort reconstruction. If you have the production DB connection string, capture the real DDL once:

```bash
npm run dump:remote -- "postgresql://postgres:[PWD]@db.<project-ref>.supabase.co:5432/postgres"
```

Review the result and remove any tables the synced Heard migrations also create (to avoid duplicate-create errors).

## Configuration

- `supabase/functions/.env` — secrets injected into the function. **Gitignored** (real keys are never committed); create it on first setup with `cp supabase/functions/.env.example supabase/functions/.env`. `HEARD_API_SECRET` here must match `VITE_HEARD_API_SECRET` in Heard's `.env.local` (`wire:heard` keeps them in sync). Email/SMS/LLM keys start blank so staging never sends real messages or spends money — fill in a provider key (e.g. `GEMINI_API_KEY`) to use the AI features.
- `supabase/config.toml` — local stack config. Email confirmations are off and the function's JWT verification is disabled (Heard does its own auth).

## Local URLs

- Function: `http://127.0.0.1:54321/functions/v1/make-server-f1a393b4`
- Studio: `http://127.0.0.1:54323`
- Postgres: `postgres://postgres:postgres@127.0.0.1:54322/postgres`
