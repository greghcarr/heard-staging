# heard-staging

A local **artificial Supabase backend** for the [Heard](../heard) app — a self-contained staging environment that runs entirely on your computer instead of a second cloud Supabase project.

It runs Heard's **real** edge function (`make-server-f1a393b4`) unmodified against a local Supabase stack (Postgres + Auth + Storage + edge runtime), all in Docker via the Supabase CLI. Heard's repo stays the single source of truth: this project *syncs* Heard's function code and migrations on every `npm run dev` and keeps **zero** Heard code committed here.

Flipping Heard between the cloud backend and this one is a single command (`npm run wire:heard` / `npm run unwire:heard`), and when wired, Heard shows a fixed **"⚠ STAGING BACKEND"** warning bar so it's never mistaken for production.

**New here? Read [How it works](#how-it-works), then jump to [First-time setup](#first-time-setup).**

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [First-time setup](#first-time-setup)
- [Everyday use](#everyday-use)
- [Command reference](#command-reference)
- [Populating test data](#populating-test-data)
- [The staging banner](#the-staging-banner)
- [Using Heard from other devices (LAN)](#using-heard-from-other-devices-lan)
- [Data model primer](#data-model-primer)
- [Project structure](#project-structure)
- [Configuration](#configuration)
- [Local URLs & credentials](#local-urls--credentials)
- [Database schema](#database-schema)
- [Troubleshooting](#troubleshooting)

## How it works

Two repos sit side by side and play different roles:

- **`heard/`** — the actual app: a React frontend **and** the backend edge function (`src/supabase/functions/server`). This is the source of truth for all code.
- **`heard-staging/`** (this repo) — orchestration only. It spins up a local Supabase stack and runs Heard's backend code against it. It contains **no Heard code** in git.

The flow:

1. **Sync** — `npm run dev` copies Heard's edge-function source and committed DB migrations *out of* the Heard repo *into* this project (into gitignored folders). So you're always running Heard's real, current backend code — never a stale fork.
2. **Run** — it boots a local Supabase stack in Docker (Postgres, Auth, Storage, edge runtime) and serves the function with hot-reload.
3. **Wire** — `npm run wire:heard` points the Heard *frontend* at this local backend by writing Heard's gitignored `.env.local` and applying one hidden line to `api-client.ts`. Its entire footprint inside the Heard repo is two uncommitted edits + a gitignored env file, all reverted byte-for-byte by `npm run unwire:heard`.

Think of it as: **`dev` = turn on the local kitchen; `wire:heard` = tell the app which kitchen to order from.** They're complementary — to use the local backend you need both running.

> Nothing here touches production. Email/SMS/LLM provider keys start blank, so staging never sends real messages or spends money.

## Prerequisites

- **Docker Desktop**, installed and **running** (the whale icon says "running"). The stack runs in Docker; the first `npm run dev` pulls several images (a few GB) and is slow — subsequent runs are fast.
- **Node 18+** (uses global `fetch` and `fs.cpSync`).
- **Git** (the wiring uses `git update-index --skip-worktree`).
- The **Heard repo** checked out as a sibling directory named `heard/` next to this one. If it lives elsewhere, set `HEARD_REPO_PATH` (copy `.env.example` → `.env` and edit).

The Supabase CLI is a dev dependency here — no global install needed.

## First-time setup

Do this once per machine:

1. Confirm [prerequisites](#prerequisites): Docker Desktop running, Node 18+, and `heard/` checked out as a sibling folder.
2. Install dependencies (also fetches the Supabase CLI binary — no Docker needed yet):
   ```bash
   npm install
   ```
3. Create the function's secrets file from the template. It's gitignored, and the local-dev `HEARD_API_SECRET` / `CRON_SECRET` are pre-filled so it works as-is. Add real provider keys (e.g. `GEMINI_API_KEY=…`) only if you want the AI features:
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env
   ```
4. *(Only if the Heard repo isn't a sibling `heard/` folder)* point this project at it:
   ```bash
   cp .env.example .env      # then set HEARD_REPO_PATH=... inside .env
   ```

Now follow [Everyday use](#everyday-use) to start it.

## Everyday use

The normal loop once setup is done. You'll use **two terminals** in this repo.

**Terminal 1 — start the backend** (leave it running; it serves the function with hot-reload):
```bash
npm run dev
```
Wait for the **`Heard staging backend is UP`** banner.

**Terminal 2 — point Heard at it and run the frontend:**
```bash
npm run wire:heard            # one-time-ish; "sticky" until you unwire
cd ../heard && npm run dev    # starts the Heard frontend on http://localhost:3000
```

Open **http://localhost:3000** — you should see the **⚠ STAGING BACKEND** bar; Heard is now talking to your local backend.

Notes:
- `wire:heard` is **sticky** — you only need it once. On later days just run `npm run dev` in both repos.
- `Ctrl+C` in Terminal 1 stops the function server but **leaves the database running** for fast restarts. Re-run `npm run dev` to re-sync + re-serve.

**Shutting down / switching back to cloud:**
```bash
# in ../heard: Ctrl+C the frontend
npm run unwire:heard   # point Heard back at the cloud backend (reverts all Heard-side edits)
npm run stop           # tear down the local Supabase stack
```

## Command reference

Quick view, then details below. All are `npm run <name>`; pass script flags after `--` (e.g. `npm run wire:heard -- --host lan`).

| Command | Purpose |
|---|---|
| [`dev`](#dev) | Sync Heard's code + start the stack + serve the function (the main command) |
| [`sync`](#sync) | Just re-sync Heard's function code & migrations |
| [`stop`](#stop) | Stop the whole local Supabase stack |
| [`status`](#status) | Print local URLs, ports, and keys |
| [`db:reset`](#dbreset) | Drop & recreate the DB, re-run migrations + `seed.sql` |
| [`wire:heard`](#wireheard) | Point the Heard frontend at this backend |
| [`unwire:heard`](#unwireheard) | Revert the Heard-side wiring |
| [`copy:posts`](#copyposts) | Copy real posts (with votes) from production into local |
| [`seed:posts`](#seedposts) | Re-apply previously copied posts (e.g. after `db:reset`) |
| [`import:polis`](#importpolis) | Import sample Polis conversations as posts |
| [`dump:remote`](#dumpremote) | Capture the authoritative prod schema |

### `dev`
The main command. Verifies Docker is up, [syncs](#sync) Heard's backend code + migrations, runs `supabase start`, then serves the function (`supabase functions serve make-server-f1a393b4`) with the secrets in `supabase/functions/.env`. Foreground; `Ctrl+C` stops the function serve but leaves the DB stack up.

### `sync`
Mirrors `heard/src/supabase/functions/server` → `supabase/functions/make-server-f1a393b4` (adding the `index.ts` entrypoint, like Heard's `deploy-server.sh`) and copies `heard/supabase/migrations/*.sql` in. Runs automatically inside `dev`; run it standalone if you changed Heard's backend code and want the synced copy refreshed without restarting the stack.

### `stop`
`supabase stop` — stops all stack containers. Data persists to the next `start` unless you also reset.

### `status`
`supabase status` — prints the local API/DB/Studio URLs and the anon/service-role keys for the running stack.

### `db:reset`
`supabase db reset` — **drops and recreates** the database, then re-runs migrations and `supabase/seed.sql`. ⚠️ This wipes everything, including any [copied or imported test posts](#populating-test-data). Afterward, re-run `npm run seed:posts` and/or `npm run import:polis` to restore them.

### `wire:heard`
Points the Heard frontend at this local backend. It:
- writes Heard's gitignored `.env.local` (`VITE_SUPABASE_FUNCTIONS_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_HEARD_API_SECRET`, `VITE_HEARD_ENV=development`),
- applies a one-line override to `src/utils/api-client.ts` and injects the [staging banner](#the-staging-banner) into `src/main.tsx`, then hides both with `git update-index --skip-worktree` so they never show in `git status` or get committed.

Flags:
- `--host lan` — auto-detect this machine's LAN IP (for [other devices](#using-heard-from-other-devices-lan)).
- `--host <ip>` — use a specific address. (No flag → `127.0.0.1`, this machine only.)

### `unwire:heard`
Reverts everything `wire:heard` did: restores `api-client.ts` + `main.tsx` byte-for-byte, un-hides them from git, and comments out the local vars in Heard's `.env.local` so the cloud backend wins again.

### `copy:posts`
Copies real posts (debate rooms with their statements **and** votes) from production into your local stack, so you have realistic, high-vote content to test against. Two source modes (DB connection string, or `--via-api` with `HEARD_API_SECRET`). See [Populating test data](#populating-test-data).

### `seed:posts`
Re-applies the gitignored `supabase/seed-prod-posts.sql` that `copy:posts` wrote — no production connection needed. Use it to restore your copied posts after a `db:reset`.

### `import:polis`
Imports real Polis conversations (from the [Computational Democracy Project's open data](https://github.com/compdemocracy/openData)) as Heard posts, with dummy users and **precomputed opinion clusters** — ideal for testing "Ask the data" and analysis features. See [Populating test data](#populating-test-data).

### `dump:remote`
Captures production's authoritative schema into the base migration. See [Database schema](#database-schema).

## Populating test data

A fresh stack has no posts. Two ways to add some.

> After a `npm run db:reset`, test data is wiped — re-run `seed:posts` (for copied posts) and `import:polis` (for Polis posts) to restore it.

### Copy real posts from production (`copy:posts`)

In Heard, a "post" is a debate room: `room:<id>` plus its `statement:<roomId>:*` takes, all in the `kv_store_f1a393b4` JSONB table. The vote counts the UI shows are **recomputed live from individual `vote:<statementId>:*` rows**, so the script copies room + statements + votes together (copying only the room would show zero votes). It does **not** copy `user:` rows — no emails/phones come across, only the opaque user IDs already embedded in votes/authorship.

**Mode A — production DB connection string** (Supabase dashboard → Project Settings → Database → Connection string). Run it in your own terminal so the credential never touches this repo:

```bash
# 1) See the most-voted posts in prod (read-only):
npm run copy:posts -- "postgresql://postgres:[PWD]@db.<ref>.supabase.co:5432/postgres"

# 2) Copy the ones you want — writes a gitignored seed file AND loads them into local:
npm run copy:posts -- "postgresql://..." --rooms <roomId1>,<roomId2>

# 3) Later (e.g. after `db:reset`) re-apply them — no prod connection needed:
npm run seed:posts
```

**Mode B — no DB string, just the production `HEARD_API_SECRET`** (`--via-api`). This pulls the same posts over HTTP from prod's edge function. The room endpoints are session-protected, so the script first mints a throwaway anonymous session via `/user/anonymous` (its one non-read side effect — a single test anon user on prod), then reads the rooms. **All user IDs are anonymized** in this mode (voters, authors, host/participants → stable synthetic `anon-N` IDs; counts/vote types preserved exactly).

```bash
# Discover (lists most-voted active rooms), then copy specific ones:
HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api \
  "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4" --anon-key <public-anon-key>

HEARD_API_SECRET=<secret> npm run copy:posts -- --via-api \
  "https://<ref>.supabase.co/functions/v1/make-server-f1a393b4" --anon-key <public-anon-key> \
  --rooms <roomId1>,<roomId2>
```
> On Windows PowerShell, inline `VAR=value` doesn't work — use the `--api-secret <secret>` flag instead of the `HEARD_API_SECRET=` prefix, or `$env:HEARD_API_SECRET="<secret>"` on its own line first.

Common flags (both modes):
- `--rooms <id1,id2>` — copy specific rooms. Omit to run **discovery** (list candidates). Mode A discovery sees *all* rooms; Mode B discovery only sees ≤20 public-community rooms, but `--rooms` can copy *any* room by ID.
- `--no-activate` — copy rooms verbatim instead of forcing them feed-visible (they likely won't appear in the feed then).
- `--local <url>` — override the local DB URL (default: from `supabase status`).
- `--api-secret` / `--anon-key` — `[--via-api only]` the prod secret and public anon key.

How copied posts are made viewable in staging:
- Each copied room is set **`isActive: true`** and de-flagged as test/event so it passes the feed filters.
- A **public community stub** is created for the room's `subHeard` (the feed hides rooms whose community is missing or private). Rooms with no community at all are filed under a public **`staging-imports`** fallback.
- Result: copied posts are viewable **without login** in staging, regardless of how gated they were in prod.

### Import sample Polis data (`import:polis`)

Need posts with many statements and clustered votes (e.g. for **"Ask the data"**)? This drives Heard's own `/import-polis` endpoint, which builds dummy test users, imports the room/statements/votes, **and recomputes opinion clusters** — so the rooms are immediately analysable.

```bash
npm run dev                                   # local stack must be running
npm run import:polis -- brexit-consensus      # one conversation
npm run import:polis -- american-assembly.bowling-green scoop-hivemind.biodiversity
npm run import:polis -- brexit-consensus --dry-run    # validate + show counts, import nothing
```

- All users are **dummy test users**; no real data involved.
- Imported rooms go in a public **`polis-samples`** community (created automatically) so they show in the feed. Override with `--subheard <name>`.
- CSVs are **reindexed** before import (real openData lists comments in reverse `comment-id` order while the vote matrix is keyed by `comment-id`).
- **Size caps** — `--max-statements` (default 80) and `--max-participants` (default 300) keep the clustering step within the edge runtime's limits; bigger imports fail with HTTP **546**. When capping statements, the **most-voted** ones are kept. Raise per-dataset if your machine can handle it.
- Browse conversation names in the [openData repo](https://github.com/compdemocracy/openData); pass the directory name. Use `--from <dir>` to import a local `comments.csv` + `participants-votes.csv` pair instead.

## The staging banner

So a staging frontend is never mistaken for production, `wire:heard` injects a fixed warning bar — **⚠ STAGING BACKEND · `<host>` — not production data** — across the top of every Heard screen. `unwire:heard` removes it.

- **How it's injected:** a small self-contained block is appended to Heard's `src/main.tsx` (hidden via `git update-index --skip-worktree`, like the `api-client.ts` override). It's plain DOM — no React/JSX or Heard CSS dependencies — so it survives changes to Heard's component tree. `unwire:heard` strips it and restores `main.tsx` byte-for-byte, so it never appears in `git status`.
- **What triggers it:** the bar renders only when `import.meta.env.VITE_SUPABASE_FUNCTIONS_URL` is set — the env var `wire:heard` writes. So it shows **iff** the frontend is talking to this local backend, and displays the actual host (`127.0.0.1:54321` or your LAN IP).
- **Removing it manually:** delete the block between the `/* heard-staging:banner:begin … */` and `/* heard-staging:banner:end */` markers in `main.tsx`, or just run `npm run unwire:heard`.

## Using Heard from other devices (LAN)

`127.0.0.1` resolves to each visitor's *own* machine, so for LAN access the frontend must point at this host's LAN IP and Vite must bind all interfaces:

```bash
npm run wire:heard -- --host lan        # auto-detect LAN IP (or: --host 192.168.1.160)
cd ../heard && npm run dev -- --host    # Vite prints a "Network:" URL
```

Other devices open `http://<LAN-IP>:3000` (Heard's Vite config pins port 3000). The local Supabase stack already binds `0.0.0.0`, so its API on `:54321` is reachable too.

- **Firewall:** allow inbound TCP **3000** and **54321** (rules named `Heard dev` / `Heard staging` were added for the Private profile).
- **IP changed (DHCP)?** Re-run `npm run wire:heard -- --host lan`.
- **Back to host-only:** `npm run wire:heard` (no flag) → `127.0.0.1`.
- **Secure-context caveat:** browsers block microphone/camera (`getUserMedia`) over plain HTTP on a LAN IP, so Heard's audio "rant" feature won't work on other devices without HTTPS. `localhost` on this host is exempt.

## Data model primer

Almost all of Heard's app data lives in one JSONB table, **`kv_store_f1a393b4`** (`key text` → `value jsonb`), keyed by prefix. The ones you'll meet most:

| Key pattern | What it is |
|---|---|
| `room:<roomId>` | a **post** / debate room |
| `statement:<roomId>:<statementId>` | a take within a room |
| `vote:<statementId>:<userId>` | one vote (`agree` / `disagree` / `pass` / `super_agree`) — vote counts are recomputed from these |
| `user:<userId>` | a user (real or dummy/anonymous) |
| `session:<sessionId>` | a login/anon session (the frontend stores its id in `localStorage`) |
| `subheard:<name>` | a **community**; rooms reference one via `subHeard`. The feed only shows rooms in a public community |
| `cluster:<roomId>:metadata`, `cluster_assignment:<roomId>:<userId>` | opinion-clustering output ("Ask the data") |

A few relational tables exist alongside it (`votes`, `cover_card_swipes`, `room_follows`, `presences`, `events`, …) — see [Database schema](#database-schema). Good to know: the **feed** (`/rooms/active`) only returns rooms in a public community to a session, which is why the import tools always create a public community — see [Troubleshooting](#troubleshooting).

## Project structure

```
heard-staging/
├─ scripts/
│  ├─ dev.mjs                  # npm run dev
│  ├─ sync-from-heard.mjs      # npm run sync
│  ├─ wire-heard.mjs           # npm run wire:heard
│  ├─ unwire-heard.mjs         # npm run unwire:heard
│  ├─ copy-posts-from-prod.mjs # npm run copy:posts / seed:posts
│  ├─ import-polis.mjs         # npm run import:polis
│  ├─ dump-remote-schema.mjs   # npm run dump:remote
│  └─ lib.mjs                  # shared helpers
├─ supabase/
│  ├─ config.toml              # local stack config (ports, auth, JWT)
│  ├─ seed.sql                 # runs on db reset (empty by default)
│  ├─ migrations/
│  │  └─ 00000000000000_base_schema.sql   # committed base schema (ours)
│  │                                       # (Heard's migrations are synced in; gitignored)
│  └─ functions/
│     ├─ .env.example          # template for function secrets
│     ├─ .env                  # gitignored secrets — you create this
│     └─ make-server-f1a393b4/ # synced from Heard; gitignored
├─ .env.example               # optional HEARD_REPO_PATH override
└─ package.json
```

Gitignored, generated, or secret (never committed): `node_modules/`, `supabase/functions/make-server-f1a393b4/`, synced migrations, `supabase/functions/.env`, `supabase/seed-prod-posts.sql`, root `.env` / `.env.local`.

## Configuration

- **`supabase/functions/.env`** — secrets injected into the function. **Gitignored**; create it from `.env.example` (see [setup](#first-time-setup)). `HEARD_API_SECRET` here must match `VITE_HEARD_API_SECRET` in Heard's `.env.local` (`wire:heard` keeps them in sync). Email/SMS/LLM keys start blank so staging never sends real messages or spends money — fill one in (e.g. `GEMINI_API_KEY`) to exercise the AI features.
- **`supabase/config.toml`** — local stack config. Email confirmations are off, and the function's JWT verification is **disabled** (Heard does its own `X-API-Key` + `X-Session-Id` auth).
- **Root `.env`** — optional; only `HEARD_REPO_PATH` if the Heard repo isn't a sibling `heard/` folder.

## Local URLs & credentials

(Run `npm run status` for the live values.)

- **Function:** `http://127.0.0.1:54321/functions/v1/make-server-f1a393b4`
- **Studio (DB GUI):** `http://127.0.0.1:54323`
- **Postgres:** `postgres://postgres:postgres@127.0.0.1:54322/postgres`
- **Heard frontend (when wired + running):** `http://localhost:3000`
- Open a specific post directly (bypasses the feed): `http://localhost:3000/room/<roomId>`

## Database schema

- **`supabase/migrations/00000000000000_base_schema.sql`** (committed, ours) creates tables that have **no migration in Heard**: the KV store `kv_store_f1a393b4`, plus `cover_card_swipes`, `room_follows`, `room_views`, `presences`, `user_reports`, `demographic_questions`, `demographic_answers`, `events`, `internal_vars`, `flyer_emails`, `org_signups`. Shapes are derived from Heard's TypeScript types.
- Heard's own committed migrations (`votes`, `llm_api_calls`, `flyer_scans`, `phone_submissions`, `statement_merges`, `user_events`, the `user_reports.reason` column) are **synced in** and run afterward.
- The image bucket `make-f1a393b4-debate-images` is created by the function itself on first upload.

### Making the schema authoritative

The base schema is a best-effort reconstruction. With the production DB connection string you can capture the real DDL once:

```bash
npm run dump:remote -- "postgresql://postgres:[PWD]@db.<project-ref>.supabase.co:5432/postgres"
```

Review the result and remove any tables the synced Heard migrations also create (to avoid duplicate-create errors).

## Troubleshooting

**`npm run dev` says Docker isn't responding.** Start Docker Desktop and wait until it reports "running", then retry. The first run also pulls multi-GB images — be patient.

**Can't log in / repeated `401` with `Unauthorized account access attempt with invalid session`.** Your browser has a stale `heard_session_id` in `localStorage` from a previous backend that this fresh stack doesn't recognize. In the staging app's DevTools console:
```js
localStorage.clear(); location.reload();
```
(or open the app in a private window). You generally **don't need to log in** to browse — the app creates an anonymous session automatically. Real email/SMS login won't work in staging anyway (no provider configured), which is expected.

**I imported/copied posts but don't see them in the feed.** The feed only shows rooms that belong to a **public community**. `copy:posts` and `import:polis` create the needed public community automatically, so a reload should show them. If not: hard-refresh (Ctrl+Shift+R); confirm the stack is up; or open the room directly at `http://localhost:3000/room/<roomId>` (direct access ignores the feed filter). The feed is also capped at ~20 rooms sorted by recency.

**`import:polis` fails with HTTP `546`.** The dataset is too big for the clustering step's resource limit. Lower `--max-statements` / `--max-participants` (defaults 80 / 300). If a failed run left a partial/duplicate room, it's the one with no cluster data — re-import at a smaller size.

**My test posts vanished.** `npm run db:reset` wipes the database. Restore copied posts with `npm run seed:posts` and Polis posts with `npm run import:polis`.

**A port is already in use / weird stack state.** Another Supabase project may be running. `npm run stop` here, check `npm run status`, then `npm run dev` again.

**Heard repo not found.** Set `HEARD_REPO_PATH` in this repo's `.env` (copy from `.env.example`) to the Heard checkout's path.

**My edits to Heard's `api-client.ts` / `main.tsx` don't show in `git status`.** That's intentional — `wire:heard` hides them with `git update-index --skip-worktree`. `npm run unwire:heard` restores them and un-hides them.
