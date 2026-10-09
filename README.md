# reops-slack-bots

Home for internal Slack automation for Team ResearchOps at Nav.

## Terminology

There is ONE Slack app / bot user (**reops**). It hosts multiple **behaviors**
(scheduled jobs under `src/bots/<behavior>/`). A "bot user" is the Slack
identity; a "behavior" is a piece of code that runs under it. Other teams
wanting their own identity create their own Slack app from this codebase.

Currently one behavior: **unanswered-reminder** — scans #researchops for old
messages without a `:solved:` reaction and posts a reminder (with a
"Merk som løst" button) to #researchops-intern. Clicking the button adds a
`:solved:` reaction to the original message via Slack interactivity.

A message counts as unanswered only if ALL of these hold:

- parent message has no `:solved:` reaction
- message is older than 1 hour (grace period) and younger than
  `nag_frequency_days` — the job never re-scans ancient history
- author is not on the ignore list
- if the message has a thread: last reply is NOT from someone on the ignore
  list (team member), and no message in the thread has `:solved:` —
  a later non-team reply flips it back to nag-worthy
- it hasn't been nagged within `nag_frequency_days` (see `nag_log`)

## Architecture

Next.js app on Nais (GCP), Postgres for settings/ignore-list/nag-log.
Cron-on-boot pattern: `instrumentation.ts` calls `server.ts` on process start,
which runs migrations (`src/lib/migrations/*.sql`, tracked in
`schema_migrations`) and starts interval jobs (`src/lib/runner.ts`).
The unanswered-reminder job wakes hourly; whether a message is due
for a (re-)nag is driven by the `nag_frequency_days` row in `settings`.

Admin UI at `/admin`, gated server-side to Team ResearchOps members
(Azure AD token via `@navikt/oasis`, live membership lookup against Team
Catalog — fails closed if Team Catalog is unreachable). Channels are picked
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
- `reactions:write` — add `:solved:` when "Merk som løst" is clicked
- `chat:write` — post reminders
- `users:read.email` — resolve Team Catalog member emails to Slack users

Interactivity: set the Request URL to
`https://reops.ansatt.nav.no/api/slack/interactivity`.

## Required env vars

| Var | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (interactivity verification) |
| `DATABASE_URL` | Postgres connection string (injected by Nais) |
| `RESEARCHOPS_CHANNEL_ID` | Fallback channel to scan (admin UI setting wins) |
| `RESEARCHOPS_INTERN_CHANNEL_ID` | Fallback reminder channel (admin UI setting wins) |
| `SLACK_WORKSPACE_SUBDOMAIN` | Workspace subdomain for permalink building (default `nav`) |
| `ADMIN_DEV_BYPASS` | `true` skips auth on `/admin` — hard-gated to `NODE_ENV !== "production"`, local dev only |

On Nais, the first two live in the `reops-slack-bots` secret; `DATABASE_URL`
is injected from the `slackbots` database on the app's SQL instance.

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
real reminders — pick a private test channel before enabling it. Buttons
always hit the deployed interactivity URL; test clicks against prod.

Without `DATABASE_URL` the server starts fine, but migrations and jobs
are skipped (logged as `server.no_database_url`). The admin UI requires a
valid Azure AD token plus Team Catalog reachability (naisdevice), so it only
works fully when deployed or behind naisdevice.
