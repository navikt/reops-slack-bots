import { test } from "node:test";
import assert from "node:assert/strict";
import {
  graceEligibleTs,
  isWithinWorkHours,
  nextWorkStart,
} from "./work-hours.ts";

/** Local-time helper: month is 1-based, matches Date() constructor args. */
function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute);
}

/** Slack ts string for a local Date. */
function ts(d: Date): string {
  return (d.getTime() / 1000).toFixed(6);
}

// 2026-10-05 is a Monday, 09 a Tuesday, 10 a Saturday, 11 a Sunday.

void test("isWithinWorkHours: boundaries", () => {
  assert.equal(isWithinWorkHours(local(2026, 10, 5, 9, 0)), true); // Mon 09:00 open
  assert.equal(isWithinWorkHours(local(2026, 10, 5, 16, 29)), true);
  assert.equal(isWithinWorkHours(local(2026, 10, 5, 16, 30)), false); // closed
  assert.equal(isWithinWorkHours(local(2026, 10, 5, 8, 59)), false);
  assert.equal(isWithinWorkHours(local(2026, 10, 10, 12, 0)), false); // Saturday
  assert.equal(isWithinWorkHours(local(2026, 10, 11, 12, 0)), false); // Sunday
});

void test("nextWorkStart: before opening → same day 09:00", () => {
  const next = nextWorkStart(local(2026, 10, 6, 7, 30)); // Tue 07:30
  assert.equal(next.getTime(), local(2026, 10, 6, 9, 0).getTime());
});

void test("nextWorkStart: after close → next workday 09:00", () => {
  const next = nextWorkStart(local(2026, 10, 9, 20, 0)); // Fri 20:00
  assert.equal(next.getTime(), local(2026, 10, 12, 9, 0).getTime()); // Mon 09:00
});

void test("nextWorkStart: weekend → Monday 09:00", () => {
  const sat = nextWorkStart(local(2026, 10, 10, 14, 0)); // Saturday
  assert.equal(sat.getTime(), local(2026, 10, 12, 9, 0).getTime()); // Monday
  const sun = nextWorkStart(local(2026, 10, 11, 10, 0)); // Sunday
  assert.equal(sun.getTime(), local(2026, 10, 12, 9, 0).getTime());
});

void test("grace: posted within work hours → plain +N hours", () => {
  const posted = local(2026, 10, 6, 10, 0); // Tue 10:00
  const eligible = new Date(graceEligibleTs(ts(posted), 1) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 6, 11, 0).getTime());
});

void test("grace: posted late afternoon can land after close", () => {
  // Requested behavior: outside-hours notifications are allowed.
  const posted = local(2026, 10, 6, 16, 0); // Tue 16:00
  const eligible = new Date(graceEligibleTs(ts(posted), 1) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 6, 17, 0).getTime()); // 17:00
});

void test("grace: posted in the evening → next workday 09:00 + grace", () => {
  const posted = local(2026, 10, 6, 20, 30); // Tue 20:30
  const eligible = new Date(graceEligibleTs(ts(posted), 1) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 7, 10, 0).getTime()); // Wed 10:00
});

void test("grace: posted before work → same day 09:00 + grace", () => {
  const posted = local(2026, 10, 6, 6, 15); // Tue 06:15
  const eligible = new Date(graceEligibleTs(ts(posted), 2) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 6, 11, 0).getTime()); // Tue 11:00
});

void test("grace: posted Friday evening → Monday 09:00 + grace", () => {
  const posted = local(2026, 10, 9, 18, 0); // Fri 18:00
  const eligible = new Date(graceEligibleTs(ts(posted), 1) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 12, 10, 0).getTime()); // Mon 10:00
});

void test("grace: posted on weekend → Monday 09:00 + grace", () => {
  const posted = local(2026, 10, 10, 12, 0); // Saturday
  const eligible = new Date(graceEligibleTs(ts(posted), 4) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 12, 13, 0).getTime()); // Mon 13:00
});

void test("grace: zero grace outside hours → next opening", () => {
  const posted = local(2026, 10, 6, 22, 0); // Tue 22:00
  const eligible = new Date(graceEligibleTs(ts(posted), 0) * 1000);
  assert.equal(eligible.getTime(), local(2026, 10, 7, 9, 0).getTime()); // Wed 09:00
});
