# reops-slack-bots

Internal Slack automation for Team ResearchOps at Nav. One Slack app
(**reops**) hosts multiple **behaviors** (jobs under `src/bots/<behavior>/`).
Currently one behavior: **unanswered-reminder** — scans a channel for old
messages without a `:solved:` reaction and posts a digest (with Suppress /
Assign-to controls) to an internal channel.

## Requirements

- pnpm + Node, Docker (local Postgres)
- A Slack app — create from `slack-app-manifest.json` at
  https://api.slack.com/apps?new_app=1 → **From a manifest**, install to
  workspace, copy bot token + signing secret. The manifest deliberately omits
  `chat:write.public`, so the bot can only post where invited (`/invite @reops`).

## Setup

`.env.local`:

```
DATABASE_URL=postgres://postgres:dev@localhost:5432/slackbots
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
ADMIN_DEV_BYPASS=true   # skips Azure AD on /admin, local dev only
```

Optional fallbacks (admin UI settings win): `RESEARCHOPS_CHANNEL_ID`,
`RESEARCHOPS_INTERN_CHANNEL_ID`, `SLACK_WORKSPACE_SUBDOMAIN` (default `nav`).

## Run locally

```zsh
pnpm install
docker compose up -d        # Postgres on :5432 (db: slackbots, pw: dev)
pnpm dev                    # Next.js on :9092 — migrations + hourly job start
pnpm check                  # tsc --noEmit
pnpm test                   # unit tests
docker compose down -v      # wipe DB volume
```

With a token set, the hourly job runs from your laptop and posts real
digests — point the channels at a private test channel first (via `/admin`,
`ADMIN_DEV_BYPASS=true` lets you in).

Without `DATABASE_URL` the server starts but migrations/jobs are skipped.

## Local testing limits

- **Webhooks (digest buttons, DMs) don't work locally** — Slack must reach
  `/api/slack/interactions`. In dev these were tested against the deployed
  app. To test live, tunnel and repoint the app's Interactivity URL:
  `cloudflared tunnel --url http://localhost:9092` (or ngrok) →
  `https://<tunnel>/api/slack/interactions`.
- **Admin auth** — Azure AD + Team Catalog only work behind naisdevice or
  deployed; use `ADMIN_DEV_BYPASS=true` locally.

## Architecture

Next.js on Nais, Postgres (Drizzle ORM). Cron-on-boot: `instrumentation.ts`
(or root layout as backstop) → `server.ts` runs migrations then starts
hourly jobs (`src/lib/runner.ts`). Migration failure is fatal; `isready` 503s
until `drizzle.__drizzle_migrations` covers `drizzle/meta/_journal.json`.
Dockerfile COPYs `drizzle/` explicitly (standalone build wouldn't) — don't
remove that line.

Ingresses: `reops.ansatt.nav.no` (SSO'd admin UI at `/admin`),
`reops-slack-bots.nav.no/api/slack` (public webhook, HMAC-verified — Slack
webhooks can't use the ansatt ingress, it forces platform SSO).

Migrations: edit `src/lib/schema.ts` → `pnpm dlx drizzle-kit generate` →
commit `drizzle/NNNN_*.sql` + `drizzle/meta/*`. Fix-forward only.
`scripts/wipe-db.sh` wipes prod (expects `DB_URL` + `DB_PASS` in
`.env.secrets`; see script header).

Admin gate: Azure AD via `@navikt/oasis` + live Team Catalog membership
(fail-closed). Admins = `admin_groups` ∪ `admin_persons`, configured in the
UI; when empty, first logged-in Nav user bootstraps it. The `frozen` setting
is a kill switch for all outbound Slack calls.

On Nais, `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` live in the
`reops-slack-bots` secret; DB comes from injected
`NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS_*` vars (the JDBC URL variant is
not wired in — unusable by `pg`).

## Behavior: unanswered-reminder

A message counts as unanswered only if ALL hold:

- past grace period (`min_age_hours`, default 1h) and younger than
  `scan_window_days` (default 14). With `work_hours_aware` on (default),
  grace for off-hours posts starts at next workday 09:00 (work hours
  Mon–Fri 09:00–16:30; Friday-evening post → due Monday 10:00)
- author not on the ignore list (manual emails + Team Catalog group members)
- not handled: team last-reply, a newer Suppress mark, or `:solved:` (parent
  or reply, anyone) — recency decides, so a non-team follow-up re-opens the
  thread (`src/lib/thread-handled.ts`). **Assign to…** routes the thread to a
  member's DM; newer thread activity re-opens it to the channel
- not nagged within `re_nag_hours` (default 7d; `nag_log`)

Digest: custom block previews (author · age · excerpt · «åpne tråd» link),
`unfurl_links:false`, ≤12 items per message (Slack's 50-block cap, 4 blocks
per item). ONE living digest per channel, tracked in `digest_messages`: new
nags → delete + repost full open set; nothing new → reconcile in place
(`chat.update`); button presses update instantly. Button/select payloads go
to `/api/slack/interactions` (HMAC-SHA256 verified with
`SLACK_SIGNING_SECRET`).
