# Unified thread reminders and tracked deliveries

Status: Accepted

## Context

Channel digests were tracked in `digest_messages`; assignment DMs were not.
Shared controls used different cleanup assumptions, and missing delivery rows
could delete a multi-item message. Reassignment from a DM could lose its preview.
The channel scan also performed unscoped cleanup incompatible with tracking DMs.

## Decision

A deep Thread reminders module owns handled/assigned routing, manual actions,
cooldowns, delivery creation/reconciliation, and cross-copy cleanup. Both scans
and webhook actions use this module. Rendering is a Slack adapter, not a source
of thread state. Its interface is tested with an in-memory store/transport;
integration tests also exercise the concrete Postgres adapter.

Slack supplies authoritative activity/content. Existing `thread_actions` supplies
manual state. `reminder_threads` is a shared preview cache keyed by source
channel/thread; `reminder_deliveries` contains destination/recipient pointers,
not duplicate content. Cleanup keys include destination channel and message
timestamp, so channel refreshes cannot purge assignment DMs.

Handling precedes assignment: assignment is routing, not resolution. Mutation
operations are serialized with a Postgres advisory lock. Replacements are posted
and tracked before old copies are deleted. Legacy untracked controls retain a
fail-closed block-removal adapter; new tracked controls use shared DB snapshots.

## Migration and consequences

An additive migration backfills channel deliveries and snapshots, preserving all
existing state and tables. Unknown old DM pointers cannot be recovered from DB
data, so old DMs remain historical and active assignments get tracked replacements.
Pause old workers during rollout; code rollback alone cannot reconcile deliveries
created by the new app. Snapshot caches are pruned after authoritative scans;
manual actions remain separate from content retention.
