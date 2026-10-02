# reops-slack-bots

Home for internal Slack bots for Team ResearchOps at Nav.

Currently one bot: **unanswered-reminder** — scans #researchops for old
messages without a `:solved:` reaction and posts a reminder (with a
"Merk som løst" button) to #researchops-intern. Clicking the button adds a
`:solved:` reaction to the original message via Slack interactivity.

## Architecture

Next.js app on Nais (GCP), Postgres for settings/ignore-list/nag-log.
Cron-on-boot pattern: `instrumentation.ts` calls `server.ts` on process start,
which runs migrations (`src/lib/migrations/*.sql`, tracked in
`schema_migrations`) and starts interval jobs (`src/lib/runner.ts`).
The unanswered-reminder job wakes every 3 hours; whether a message is due
for a (re-)nag is driven by the `nag_frequency_days` row in `settings`.

Admin UI at `/admin`, gated server-side to Team ResearchOps members
(Azure AD token via `@navikt/oasis`, live membership lookup against Team
Catalog — fails closed if Team Catalog is unreachable).

## Slack app setup

Required bot token scopes:

- `channels:history` — read messages in #researchops
- `channels:read` — channel metadata
- `reactions:read` — check for `:solved:` reactions
- `reactions:write` — add `:solved:` when "Merk som løst" is clicked
- `chat:write` — post reminders to #researchops-intern
- `usergroups:read` — expand ignored usergroups into member IDs

Interactivity: set the Request URL to
`https://reops-slack-bots.ansatt.nav.no/api/slack/interactivity`.

## Required env vars

| Var | Description |
|---|---|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret (interactivity verification) |
| `DATABASE_URL` | Postgres connection string (injected by Nais) |
| `RESEARCHOPS_CHANNEL_ID` | Channel to scan (e.g. `C0123…`) |
| `RESEARCHOPS_INTERN_CHANNEL_ID` | Channel to post reminders to |
| `SLACK_RESEARCHOPS_USERGROUP_ID` | Usergroup (`S…`) seeded onto the ignore list at startup |

On Nais, the first two live in the `reops-slack-bots` secret; `DATABASE_URL`
is injected from the `slackbots` database on the app's SQL instance.

## Local development

```zsh
pnpm install
pnpm dev        # Next.js on port 9092
pnpm check      # tsc --noEmit
```

Without `DATABASE_URL` the server starts fine, but migrations and bot jobs
are skipped (logged as `server.no_database_url`). The admin UI requires a
valid Azure AD token plus Team Catalog reachability (naisdevice), so it only
works fully when deployed or behind naisdevice.
