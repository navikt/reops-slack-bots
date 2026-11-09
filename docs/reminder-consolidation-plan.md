# Reminder consolidation checkpoint

## Decisions

- Slack thread activity plus `thread_actions` determines handled/assigned state.
  Evaluate handling before routing, so a reaction can close an assigned thread.
- `reminder_threads` caches one preview per source channel/thread.
- `reminder_deliveries` tracks every rendered copy, including assignment DMs.
  Keys include destination channel and delivery timestamp; cleanup is scoped.
- One reminder module owns scans, assignment/suppression/release, delivery
  reconciliation, and reminder cooldown writes. Slack rendering is an adapter.
- Serialize reminder mutations across scans/webhooks with a Postgres advisory
  lock. Do not infer thread state from cached Slack blocks.
- Legacy untracked messages retain safe single-entry removal from their actual
  blocks. Existing untracked DMs cannot be backfilled from the database.

## Migration and rollout

- Add tables; copy existing channel digest previews/deliveries. Preserve legacy
  tables, settings, manual actions, assignments, and cooldowns. No wipe/reset.
- New delivery table isolates DMs from old-version channel cleanup.
- Pause the bot for rollout; ensure old workers stop before unpausing. Old
  versions do not maintain the new tracking table, so rollback after new
  deliveries exist requires a reconciliation plan, not an automatic guarantee.
- Old untracked assignment DMs stay historical; scans create tracked replacements
  for active assignments. Never bulk-delete untracked Slack messages.

## Implementation status

- Reminder module and concrete DB/Slack adapters implemented. Scans and webhook
  actions use the shared module; synthetic wiring checks use the same renderer.
- Additive Drizzle migration generated and backfill inspected. Legacy tables
  remain; new runtime has no legacy channel-ledger writers.
- Unit coverage includes cross-destination cleanup, reassign previews,
  assignment handling precedence, repeated reminders, legacy controls,
  retry/failure cases and orphan snapshot retention.
- DB integration suite covers fresh and seeded legacy migrations, unchanged
  legacy rows, concrete adapter operations, FK/check constraints and locking.
- Migration/adapter verification passed via user-run `peekrun` on disposable
  local Postgres (2026-11-09): all four DB tests passed, none skipped. This
  includes fresh installation and reruns, unchanged populated legacy tables,
  latest-preview backfill, sibling preservation during reassign/suppress, and
  advisory-lock contention. Sandbox Docker access was unavailable to the agent;
  the user supplied the successful test output.
- Latest local verification: `pnpm check` passes; 57 unit tests pass;
  `drizzle-kit check` passes. The Next.js production build passes without
  DB/Slack credentials. The database verification blocker is cleared.
- No production DB access or deployment performed. Follow the paused rollout
  and post-deploy readiness/manual-action checks described above and in README.
