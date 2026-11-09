import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HANDLED_EMOJIS, getHandledEmojis, handledEmojiOptions, hasHandledReaction, parseHandledEmojis } from "./handled-emojis.ts";

void test("unset config uses the preselected defaults", () => {
  assert.deepEqual(getHandledEmojis(null), [...DEFAULT_HANDLED_EMOJIS]);
  assert.deepEqual(getHandledEmojis(null), ["raised_hands", "solved", "dart", "heart", "heartpulse", "meow_heart", "white_check_mark"]);
});

void test("colon-wrapped and bare input produce identical canonical dropdown and chip options", () => {
  const expected = [{ value: "other", label: ":other:" }];
  assert.deepEqual(handledEmojiOptions(["other"]), expected);
  assert.deepEqual(handledEmojiOptions([":other:"]), expected);
  assert.deepEqual(handledEmojiOptions(["other", ":other:"]), expected);
});

void test("normalizes comma/space/newline separators and optional colons, deduplicating", () => {
  assert.deepEqual(parseHandledEmojis(":solved:, thanks\n:white_check_mark: solved :+1:"), ["solved", "thanks", "white_check_mark", "+1"]);
});

void test("empty config disables reaction handling instead of restoring defaults", () => {
  assert.deepEqual(getHandledEmojis(""), []);
  assert.equal(hasHandledReaction([{ name: "solved" }], new Set(getHandledEmojis(""))), false);
});

void test("first-time form shows default chips; saved cleared selection stays empty", () => {
  const firstLoad = handledEmojiOptions(getHandledEmojis(null));
  assert.deepEqual(firstLoad.map((option) => option.value), [...DEFAULT_HANDLED_EMOJIS]);
  assert.equal(firstLoad[0]?.label, ":raised_hands:");

  const savedEmptyList = parseHandledEmojis("").join(", ");
  assert.deepEqual(handledEmojiOptions(getHandledEmojis(savedEmptyList)), []);
});

void test("reset defaults round-trip through the runtime setting", () => {
  const resetValue = DEFAULT_HANDLED_EMOJIS.join(", ");
  assert.deepEqual(getHandledEmojis(resetValue), [...DEFAULT_HANDLED_EMOJIS]);
});

void test("custom list replaces defaults; missing reactions are safe", () => {
  const emojis = new Set(getHandledEmojis("custom-done"));
  assert.equal(hasHandledReaction([{ name: "custom-done" }], emojis), true);
  assert.equal(hasHandledReaction([{ name: "solved" }], emojis), false);
  assert.equal(hasHandledReaction(undefined, emojis), false);
  assert.equal(hasHandledReaction([{}], emojis), false);
});

void test("rejects unicode emoji, malformed names and oversized input", () => {
  for (const input of ["✅", ":solved", "solved:", "foo/bar", "x".repeat(10_001)]) {
    assert.throws(() => parseHandledEmojis(input));
  }
});
