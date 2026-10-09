# reops-slack-bots

Home for internal Slack automation for Team ResearchOps at Nav.

## Terminology

There is ONE Slack app / bot user (**reops**). It hosts multiple **behaviors**
(scheduled jobs under `src/bots/<behavior>/`). A "bot user" is the Slack
identity; a "behavior" is a piece of code that runs under it. Other teams
wanting their own identity create their own Slack app from this codebase.

Currently one behavior: **unanswered-reminder** — scans #researchops for old
messages without a `:solved:` reaction and posts one digest message per scan
to #researchops-intern: up to 5 bare permalinks (Slack's unfurl cap), which
Slack auto-unfurls into message previews. No buttons — resolving means
reading and replying to the actual thread.

A message counts as unanswered only if ALL of these hold:

- message is past its grace period (default 1 *work* hour — evenings and
  weekends don't count; a Friday-evening post becomes due Monday 10:00) and
  younger than `scan_window_days` — the job never re-scans ancient history
- author is not on the ignore list
- not handled: `:solved:` (on the parent or a reply, set by anyone) and a
  team last-reply are equal-rank handled signals — recency decides, so a
  follow-up question from a non-team member re-opens the thread (logic in
  `src/lib/thread-handled.ts`, unit-tested)
- it hasn't been nagged within the `re_nag_hours` cooldown (see `nag_log`)

## Architecture

Next.js app on Nais (GCP), Postgres for settings/ignore-list/nag-log.
Cron-on-boot pattern: `instrumentation.ts` calls `server.ts` on process start,
which runs migrations (`src/lib/migrations/*.sql`, tracked in
`schema_migrations`) and starts interval jobs (`src/lib/runner.ts`).
The unanswered-reminder job wakes hourly; whether a message is due
for a (re-)nag is driven by the `scan_window_days` / `min_age_hours` /
`re_nag_hours` rows in `settings`. Grace-period math lives in
`src/lib/work-hours.ts` (unit-tested in `work-hours.test.ts`, run with
`pnpm test`).

Admin UI at `/admin`, gated server-side (Azure AD token via `@navikt/oasis`,
live membership lookup against Team Catalog — fails closed if Team Catalog
is unreachable). Who counts as admin is configured in the admin UI itself:
members of the Team Catalog groups in the `admin_groups` table. Bootstrap:
when no admin group is configured yet, any logged-in Nav user passes —
first-come-first-served, the first visitor claims the page by adding their
team. Channels are picked
in the admin UI from the channels the bot user has been invited to
(settings keys `unanswered_reminder.source_channel_id` /
`.target_channel_id`); the `RESEARCHOPS_*_CHANNEL_ID` env vars act as
fallbacks. A single on/off switch (`frozen` setting) stops all outbound
Slack calls — usable by any team member as a kill switch, no deploy needed.

The root page `/` is a public (internal) explainer: what the bot does, which
channels it watches, and how to use `:solved:` / invite the bot.

## Slack app setup

Create the app at https://api.slack.com/apps?new_app=1 → **From a manifest** →
paste `slack-app-manifest.json` (repo root). Then install to workspace and
copy the bot token + signing secret into the `reops-slack-bots` secret.

Note: the manifest deliberately omits `chat:write.public`, so the bot user can only
post to channels it has been invited to.

Required bot token scopes:

- `channels:history` — read messages in public channels the bot is invited to
- `channels:read` — public channel metadata
- `groups:history` — read messages in private channels the bot is invited to
- `groups:read` — private channel metadata
- `reactions:read` — check for `:solved:` reactions
- `chat:write` — post the digest
- `users:read.email` — resolve Team Catalog member emails to Slack users

## Required env vars

| Var | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (only needed if interactivity is re-added) |
| `DATABASE_URL` | Postgres connection string (local dev; on Nais the `NAIS_DATABASE_*` vars win) |
| `RESEARCHOPS_CHANNEL_ID` | Fallback channel to scan (admin UI setting wins) |
| `RESEARCHOPS_INTERN_CHANNEL_ID` | Fallback reminder channel (admin UI setting wins) |
| `SLACK_WORKSPACE_SUBDOMAIN` | Workspace subdomain for permalink building (default `nav`) |
| `ADMIN_DEV_BYPASS` | `true` skips auth on `/admin` — hard-gated to `NODE_ENV !== "production"`, local dev only |

On Nais, the first two live in the `reops-slack-bots` secret; the database
connection comes from the injected `NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS_*`
vars (URL + mounted sqeletor certs, verify-ca) — the JDBC URL variant is not
usable by `pg` and is deliberately not wired in.

## Local development

```zsh
pnpm install
docker compose up -d   # local Postgres on :5432 (db: slackbots, pw: dev)
pnpm dev               # Next.js on port 9092 — migrations + jobs start if
                       # DATABASE_URL is set in .env.local
pnpm check             # tsc --noEmit
```

`.env.local` for full local loop:

```
DATABASE_URL=postgres://postgres:dev@localhost:5432/slackbots
DATABASE_SSL=false
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
ADMIN_DEV_BYPASS=true   # skips Azure AD + Team Catalog on /admin (dev only)
```

Note: with a token set, the hourly job runs from your laptop too and can post
real digests — pick a private test channel before enabling it.

Without `DATABASE_URL` the server starts fine, but migrations and jobs
are skipped (logged as `server.no_database_url`). The admin UI requires a
valid Azure AD token plus Team Catalog reachability (naisdevice), so it only
works fully when deployed or behind naisdevice.
