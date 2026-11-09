import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnosticThreads,
  diagnosticChannel,
  diagnosticPerson,
  inferThreadSource,
  parseAdminThreadCommand,
  relativeTime,
  slackTimestampIso,
} from "./admin-diagnostics.ts";

void test("Slack timestamps have a readable ISO form without changing the exact copyable ID", () => {
  assert.equal(slackTimestampIso("1000.000001"), "1970-01-01T00:16:40.000Z");
  for (const value of [
    "",
    "not-a-date",
    "1e10.0",
    "NaN",
    "123",
    "9".repeat(400) + ".1",
  ])
    assert.equal(slackTimestampIso(value), null);
});

void test("relative times describe past/future and unavailable timestamps safely", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(relativeTime("2026-11-09T10:00:00Z", now), "2 hours ago");
  assert.equal(relativeTime("2026-11-09T12:30:00Z", now), "in 30 minutes");
  assert.equal(relativeTime(null, now), "Unknown time");
  assert.equal(relativeTime("invalid", now), "Unknown time");
});

void test("source inference prefers stored source and refuses ambiguous thread IDs", () => {
  assert.deepEqual(inferThreadSource(["COLD", "COLD"], "CNEW"), {
    source: "COLD",
    inferred: false,
  });
  assert.deepEqual(inferThreadSource([], "CNEW"), {
    source: "CNEW",
    inferred: true,
  });
  assert.deepEqual(inferThreadSource(["COLD", "COTHER"], "CNEW"), {
    source: null,
    inferred: false,
  });
});

void test("identity fallbacks retain IDs only as raw metadata, not human labels", () => {
  assert.equal(diagnosticPerson("U123", {}).name, "Unknown Slack user");
  assert.equal(diagnosticPerson("U123", {}).id, "U123");
  assert.equal(diagnosticChannel("D123", {}).name, "Direct message");
  assert.equal(diagnosticChannel("C123", {}).name, "Unknown channel");
});

void test("diagnostics unify actions, cooldowns and delivery pointers without inventing live status", () => {
  const rows = buildDiagnosticThreads({
    actions: [
      {
        message_ts: "1000.000001",
        channel_id: "D123",
        action: "assigned",
        actor_user_id: "U111",
        assignee_user_id: "U222",
        actioned_at: "2026-11-09T11:00:00Z",
      },
    ],
    nags: [
      {
        message_ts: "1000.000001",
        channel_id: "D123",
        last_nagged_at: "2026-11-09T10:00:00Z",
      },
    ],
    cooldowns: [
      {
        message_ts: "1000.000001",
        channel_id: "D123",
        next_eligible_at: "2026-11-16T10:00:00Z",
      },
    ],
    snapshots: [
      {
        sourceChannelId: "C123",
        threadTs: "1000.000001",
        permalink: "https://example.invalid/thread",
        textExcerpt: "A question",
        authorLabel: "Sam",
      },
    ],
    deliveries: [
      {
        sourceChannelId: "C123",
        threadTs: "1000.000001",
        channelId: "D123",
        deliveryTs: "2000.000002",
        kind: "assignment_dm",
      },
    ],
    people: {
      U222: {
        id: "U222",
        name: "Ada Example",
        email: "ada@example.invalid",
        resolved: true,
      },
    },
    channels: {
      C123: {
        id: "C123",
        name: "help-team",
        isDm: false,
        isPrivate: false,
        resolved: true,
      },
    },
    configuredSource: "C999",
    permalink: () => "fallback",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].assignee?.name, "Ada Example");
  assert.equal(rows[0].sourceChannel?.name, "help-team");
  assert.equal(rows[0].sourceChannel?.id, "C123");
  assert.equal(rows[0].actionChannel?.isDm, true);
  assert.equal(rows[0].deliveries[0].deliveryTs, "2000.000002");
  assert.equal(rows[0].nextEligibleAt, "2026-11-16T10:00:00Z");
  assert.equal("status" in rows[0], false);
});

void test("admin commands require validated IDs, known action and a stale-edit version", () => {
  const input = {
    sourceChannelId: "C123",
    threadTs: "1000.000001",
    action: "assigned",
    assignee: "U123",
    expectedActionedAt: null,
  };
  assert.equal(parseAdminThreadCommand(input).assignee, "U123");
  for (const invalid of [
    null,
    [],
    { ...input, sourceChannelId: "D123" },
    { ...input, threadTs: "oops" },
    { ...input, action: "wipe" },
    { ...input, assignee: "anyone" },
    { ...input, expectedActionedAt: undefined },
    { ...input, expectedActionedAt: "invalid" },
  ])
    assert.throws(() => parseAdminThreadCommand(invalid));
  assert.equal(
    parseAdminThreadCommand({
      sourceChannelId: "C123",
      threadTs: "1000.000001",
      action: "inspect",
    }).expectedActionedAt,
    undefined,
  );
});
