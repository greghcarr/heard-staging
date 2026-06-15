# heard-staging

A local **artificial Supabase backend** for the [Heard](../heard) app — a self-contained staging environment that runs on this computer instead of a second cloud Supabase project.

It runs Heard's **real** edge function (`make-server-f1a393b4`) unmodified against a local Supabase stack (Postgres + Auth + Storage + edge runtime), all in Docker via the Supabase CLI. Heard's repo stays the single source of truth: this project *syncs* Heard's function code and migrations on every `npm run dev` and keeps **zero** Heard code committed here.

Flipping Heard between the cloud backend and this one is a single command (`npm run wire:heard` / `npm run unwire:heard`), and the only change it makes inside the Heard repo is one uncommitted line + a gitignored `.env.local`.

## Prerequisites

- **Docker Desktop** running.
- **Node 18+** (uses `fs.cpSync`).
- The Heard repo checked out as a sibling directory named `heard` (or set `HEARD_REPO_PATH`, see `.env.example`).

The Supabase CLI is a dev dependency here — no global install needed.

## Quick start

```bash
npm install            # fetches the Supabase CLI binary (no Docker needed yet)
npm run dev            # syncs Heard code, starts the stack, serves the function
```

Then, in another terminal:

```bash
npm run wire:heard     # point Heard's .env.local at http://127.0.0.1:54321
cd ../heard && npm run dev
```

Heard now talks to your local backend. To switch back to the cloud:

```bash
npm run unwire:heard
```

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
| `npm run wire:heard` | Point Heard at this backend (writes `.env.local`, patches `api-client.ts`, hides it from git) |
| `npm run unwire:heard` | Revert the Heard-side wiring |
| `npm run dump:remote` | Capture the authoritative prod schema (see below) |

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

- `supabase/functions/.env` — secrets injected into the function. `HEARD_API_SECRET` here must match `VITE_HEARD_API_SECRET` in Heard's `.env.local` (`wire:heard` keeps them in sync). Email/SMS/LLM keys are blank so staging never sends real messages or spends money.
- `supabase/config.toml` — local stack config. Email confirmations are off and the function's JWT verification is disabled (Heard does its own auth).

## Local URLs

- Function: `http://127.0.0.1:54321/functions/v1/make-server-f1a393b4`
- Studio: `http://127.0.0.1:54323`
- Postgres: `postgres://postgres:postgres@127.0.0.1:54322/postgres`
