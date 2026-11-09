# reops-slack-bots

Internal Slack automation for Team ResearchOps at Nav. One Slack app
(**reops**) hosts multiple **behaviors** (jobs under `src/bots/<behavior>/`).
Currently one behavior: **unanswered-reminder** — scans a channel for old
messages without a configured handled reaction (or a reply from a member in a set)
and posts a digest (with Suppress /
Assign-to controls) to an internal channel.

## Requirements

- pnpm + Node, Docker (local Postgres, for local dev only)
- A Slack app — create from `slack-app-manifest.json` at
  https://api.slack.com/apps?new_app=1 → **From a manifest**, install to
  workspace, copy bot token + signing secret. The manifest deliberately omits
  `chat:write.public`, so the bot can only post where invited (`/invite @reops`).

## Setup

### Nais (deployed)

Set the Slack secrets as **Nais secrets** — key-value pairs on the
`reops-slack-bots` secret in the Nais console (app → **Secrets** tab):

- `SLACK_BOT_TOKEN` — Bot User OAuth Token (`xoxb-…`)
- `SLACK_SIGNING_SECRET` — app signing secret (verifies webhooks)

The database needs no setup: Nais injects
`NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS_*` (URL + mounted sqeletor certs;
the JDBC URL variant is not wired in — unusable by `pg`).

### Local (`.env.local`)

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

- **Webhooks (digest buttons, DMs) don't work out of the box** — Slack
  delivers them over the internet, so it needs a public URL that forwards to
  your local app. Options:
  - Test against the deployed app instead (what we did in dev).
  - Expose localhost with a tunnel, e.g. `ngrok http 9092` (free account
    required) or `cloudflared tunnel --url http://localhost:9092`. Then point
    the Slack app's **Interactivity Request URL** (api.slack.com → your app →
    Interactivity & Shortcuts) at `https://<tunnel-url>/api/slack/interactions`
    while testing, and change it back when done.
- **Admin auth** — Azure AD + Team Catalog only work behind naisdevice or
  deployed; use `ADMIN_DEV_BYPASS=true` locally.

## Admin diagnostics and access lists

`/admin/diagnostics` is a separate wide view linked from Advanced settings.
It uses Aksel's preview DataGrid with sorting/filtering, human Slack identities,
relative thread ages, expandable copyable IDs/ISO timestamps, and a sticky
right-side Actions menu. Content columns absorb unused width through Aksel's
controlled column-width API, so Actions stays at the right edge even when the
grid doesn't need to scroll. Groups and individuals use the same aligned grid
on the settings page; groups come first, and one shared search input stays below
the list. Selecting a person or group adds it immediately.

Diagnostics distinguish saved manual actions from actual Slack status. Expanding
a thread or choosing **Check Slack status** reads the conversation on demand and
shows when it was checked; unavailable Slack/Team Catalog data is never labelled
handled/open by guesswork. **Unsuppress**, **Release to channel**, and
**Assign/Reassign** use the shared reminder manager, validate assignees against
the configured team, and reject stale edits. Unsuppress removes only the manual
suppression/cooldown; it does not override handled reactions or team replies.

`POST /api/admin/thread-actions` requires admin authentication and JSON, returns
Problem Details for errors, and records the authenticated actor rather than an
actor supplied by the browser. Actions/status checks are paused while the bot is
off. `GET /api/admin/state?view=diagnostics` opts into preview/identity enrichment;
ordinary settings requests avoid those additional lookups. No schema migration
or package upgrade is required for this UI change.

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

## Behavior: unanswered-reminder

A message counts as unanswered only if ALL hold:

- past grace period (`min_age_hours`, default 1h) and younger than
  `scan_window_days` (default 14). With `work_hours_aware` on (default),
  grace for off-hours posts starts at next workday 09:00 (work hours
  Mon–Fri 09:00–16:30; Friday-evening post → due Monday 10:00)
- author not on the ignore list (manual emails + Team Catalog group members)
- not handled: team last-reply, a newer Suppress mark, or a configured handled reaction (parent
  or reply, anyone) — recency decides, so a non-team follow-up re-opens the
  thread (`src/lib/thread-handled.ts`). **Assign to…** routes the thread to a
  member's DM; newer thread activity re-opens it to the channel
- not nagged within `re_nag_hours` (default 7d; `nag_log`)

Handled reactions are configured in **Admin → Handled emojis** and stored in
`unanswered_reminder.handled_emojis`. Add Slack names with or without colons in
the combobox, or paste a comma- or whitespace-separated list. Each name becomes
a removable chip. Adding, removing, or pasting emojis saves automatically,
including when you remove the final chip. **Reset to default** restores and saves
the default list. Defaults to
`raised_hands`, `solved`, `dart`, `heart`, `heartpulse`, `meow_heart`, and
`white_check_mark` only when no list has been saved. An empty saved list disables reaction
handling, but team replies and Suppress still count. Changes apply on the next
scan without a restart and replace the entire list.

Channel digests and assignment DMs share the reminder module
(`src/lib/reminders.ts`). Slack content/reactions plus `thread_actions`
determine thread state; handling is evaluated before assignment routing.
`reminder_threads` caches a shared preview, and `reminder_deliveries` records
every rendered copy with its destination and recipient. Orphan previews outside
the current open scan set are pruned; cached content is not permanent history.

Both destinations use the same block renderer: author · age · excerpt · thread
link, `unfurl_links:false`, ≤12 items per message. Re-reminding posts a fresh
batch for that destination and only then retires its old messages. Assignment
DMs consolidate a person's open items rather than accumulating old reminders.
Scans without new reminders update existing messages in place. Handling,
reassigning, or releasing a thread updates all tracked copies without removing
their siblings. Release clears its reminder cooldown so it can return to the
channel on the next scan.

Scans and button actions use a Postgres advisory lock to prevent concurrent
rewrites. Button/select payloads go to `/api/slack/interactions` (HMAC-SHA256
verified with `SLACK_SIGNING_SECRET`). Only legacy untracked messages use their
actual Slack blocks for safe single-entry removal; unknown layouts are left
unchanged. Synthetic admin wiring tests use the same renderer but aren't real
threads and are deliberately not tracked.

### Production migration: unified reminders

`drizzle/0003_unified_reminders.sql` adds the two reminder tables and copies
existing channel-digest rows into them. Where a thread has multiple previews,
the newest becomes its shared snapshot. Existing settings, suppressions,
assignments, cooldowns, and legacy tables are preserved. No database reset.

Old assignment DMs have no stored Slack message pointers and cannot be
backfilled from the database. They remain historical; buttons still work through
the legacy adapter. Active assignments get a tracked replacement on a later
scan, even inside the old cooldown. An occasional duplicate during this cutover
is expected; untracked Slack history is never bulk-deleted.

Before production rollout:

1. Run `pnpm test:db` against a **dedicated local test Postgres on a non-5432
   port**, using `REMINDER_TEST_DATABASE_URL`. The test creates/drops only its
   generated `reminder_test_*` databases; it never defaults to `DATABASE_URL`.
   It verifies fresh and populated migrations, unchanged legacy rows, and the
   real DB adapter. Ordinary `pnpm test` skips this test without that variable.
2. Pause the bot in Admin, allow any active run to finish, and wait for the
   10-second Slack kill-switch cache to expire.
3. Deploy the new app; boot applies the additive migration. Ensure every old
   worker has stopped before unpausing. Old workers don't maintain new tracking.
4. Verify migration readiness, saved emoji settings, and existing manual actions;
   then unpause and check one channel digest and assignment DM.

Database schema remains compatible with the previous app, but delivery
bookkeeping changes after cutover. Rolling back app code alone doesn't reconcile
new DMs or restore the legacy tracking table to current state; pause and review
delivery cleanup first. Don't deploy an unverified migration.
