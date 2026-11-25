import assert from "node:assert/strict";
import { test } from "node:test";
import { reminderAgeLabels } from "./reminder-age.ts";

const now = Date.parse("2026-11-25T12:00:00Z");
const hour = 3_600_000;
const day = 24 * hour;
const ts = (ms: number) => (ms / 1000).toFixed(6);
const permalink = (messageTs: string) => `https://nav.slack.com/archives/C_SOURCE/p${messageTs.replace(".", "")}`;

test("a reminder ages the linked reply separately from the thread", () => {
  const parent = ts(now - 400 * day);
  const reply = ts(now - 3 * hour);
  assert.deepEqual(reminderAgeLabels({ ts: parent, permalink: `${permalink(reply)}?thread_ts=${parent}&cid=C_SOURCE` }, now), {
    unanswered: "ubesvart i 3 timer",
    threadStarted: "Tråden startet for 400 dager siden",
    oldButGold: true,
  });
});

test("a reminder linking the parent does not repeat the same age", () => {
  const parent = ts(now - hour);
  assert.deepEqual(reminderAgeLabels({ ts: parent, permalink: permalink(parent) }, now), {
    unanswered: "ubesvart i 1 time",
    threadStarted: null,
    oldButGold: false,
  });
});

test("the badge requires strictly more than 365 days", () => {
  const anniversary = ts(now - 365 * day);
  assert.equal(reminderAgeLabels({ ts: anniversary, permalink: permalink(anniversary) }, now)?.oldButGold, false);
  assert.equal(reminderAgeLabels({ ts: anniversary, permalink: permalink(anniversary) }, now + 1)?.oldButGold, true);
});

test("a non-Slack preview link does not imply an unanswered age", () => {
  assert.equal(reminderAgeLabels({ ts: ts(now - hour), permalink: "https://example.com/preview" }, now), null);
});
