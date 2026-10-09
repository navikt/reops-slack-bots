import { test } from "node:test";
import assert from "node:assert/strict";
import { isThreadHandled } from "./thread-handled.ts";

const TEAM = new Set(["U_TEAM1", "U_TEAM2"]);

type Msg = Parameters<typeof isThreadHandled>[0];

function msg(partial: Partial<Msg>): Msg {
  return {
    ts: "1000.000000",
    latestReplies: [],
    parentSolved: false,
    ...partial,
  };
}

void test("no replies, no emoji → open", () => {
  assert.equal(isThreadHandled(msg({}), TEAM), false);
});

void test("no replies, parent :solved: → handled", () => {
  assert.equal(isThreadHandled(msg({ parentSolved: true }), TEAM), true);
});

void test("parent :solved:, then non-team follow-up → re-opened", () => {
  assert.equal(
    isThreadHandled(
      msg({
        parentSolved: true,
        latestReplies: [{ user: "U_ASKER", ts: 2000, solved: false }],
      }),
      TEAM,
    ),
    false,
  );
});

void test("parent :solved:, follow-up, then :solved: reply → handled again", () => {
  assert.equal(
    isThreadHandled(
      msg({
        parentSolved: true,
        latestReplies: [
          { user: "U_ASKER", ts: 2000, solved: false },
          { user: "U_ASKER", ts: 3000, solved: true },
        ],
      }),
      TEAM,
    ),
    true,
  );
});

void test("team member last → handled", () => {
  assert.equal(
    isThreadHandled(
      msg({
        latestReplies: [
          { user: "U_ASKER", ts: 2000, solved: false },
          { user: "U_TEAM1", ts: 3000, solved: false },
        ],
      }),
      TEAM,
    ),
    true,
  );
});

void test("non-team last, no solve → open", () => {
  assert.equal(
    isThreadHandled(
      msg({
        latestReplies: [
          { user: "U_TEAM1", ts: 2000, solved: false },
          { user: "U_ASKER", ts: 3000, solved: false },
        ],
      }),
      TEAM,
    ),
    false,
  );
});

void test("asker self-solves with :solved: on their reply → handled", () => {
  assert.equal(
    isThreadHandled(
      msg({
        latestReplies: [{ user: "U_ASKER", ts: 2000, solved: true }],
      }),
      TEAM,
    ),
    true,
  );
});

void test("solved reply, then newer non-team reply → re-opened", () => {
  assert.equal(
    isThreadHandled(
      msg({
        latestReplies: [
          { user: "U_TEAM1", ts: 2000, solved: true },
          { user: "U_ASKER", ts: 3000, solved: false },
        ],
      }),
      TEAM,
    ),
    false,
  );
});

void test("non-team reply, then team reply without emoji → handled", () => {
  assert.equal(
    isThreadHandled(
      msg({
        latestReplies: [
          { user: "U_ASKER", ts: 2000, solved: false },
          { user: "U_ASKER", ts: 2500, solved: false },
          { user: "U_TEAM2", ts: 3000, solved: false },
        ],
      }),
      TEAM,
    ),
    true,
  );
});
