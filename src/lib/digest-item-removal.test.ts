import { test } from "node:test";
import assert from "node:assert/strict";
import { removeDigestItem, type MessageBlock } from "./digest-item-removal.ts";

function item(ts: string): MessageBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `preview ${ts}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `quote ${ts}` }] },
    { type: "actions", block_id: `digest_item_${ts}`, elements: [{ type: "button", value: ts }] },
  ];
}

function message(...threads: string[]): MessageBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: "Assigned to you" } },
    { type: "divider" },
    ...threads.flatMap((ts, index) => index ? [{ type: "divider" }, ...item(ts)] : item(ts)),
  ];
}

void test("resolving bottom item preserves older sibling without DB tracking", () => {
  const blocks = message("1000.000001", "2000.000002");
  const result = removeDigestItem(blocks, "2000.000002");
  assert.equal(result?.remainingItems, 1);
  assert.deepEqual(result?.blocks, message("1000.000001"));
  assert.deepEqual(blocks, message("1000.000001", "2000.000002"));
});

void test("resolving first or middle item preserves other previews and controls", () => {
  for (const ts of ["1000.000001", "2000.000002", "3000.000003"]) {
    const threads = ["1000.000001", "2000.000002", "3000.000003"];
    const result = removeDigestItem(message(...threads), ts);
    assert.equal(result?.remainingItems, 2);
    assert.deepEqual(result?.blocks, message(...threads.filter((value) => value !== ts)));
  }
});

void test("only the final remaining item permits deleting the Slack message", () => {
  assert.equal(removeDigestItem(message("1000.000001"), "1000.000001")?.remainingItems, 0);
});

void test("unknown target, duplicated target, or unexpected layout leaves message untouched", () => {
  assert.equal(removeDigestItem(message("1000.000001"), "unknown"), null);
  assert.equal(removeDigestItem(message("1000.000001", "1000.000001"), "1000.000001"), null);
  const malformed = message("1000.000001", "2000.000002");
  malformed.splice(3, 1);
  assert.equal(removeDigestItem(malformed, "2000.000002"), null);
  assert.equal(removeDigestItem([...message("1000.000001"), { type: "section", text: { text: "unrecognized sibling" } }], "1000.000001"), null);
  assert.equal(removeDigestItem([], "1000.000001"), null);
});
