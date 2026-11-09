import { test } from "node:test";
import assert from "node:assert/strict";
import { createReminderManager, MAX_REMINDER_ITEMS, routeThread, type ReminderAction, type ReminderDelivery, type ReminderDestination, type ReminderItem, type ReminderStore, type ReminderTransport, type ScannedThread } from "./reminders.ts";

const SOURCE = "C_SOURCE";
const TARGET = "C_TEAM";
const TEAM = new Set(["U_TEAM"]);
const item = (ts: string): ReminderItem => ({ ts, permalink: `https://slack.example/archives/${SOURCE}/p${ts.replace(".", "")}`, text: `Preview ${ts}`, authorLabel: "Asker", imageUrl: null });
const thread = (ts: string, overrides: Partial<ScannedThread> = {}): ScannedThread => ({ ts, user: "U_ASKER", parentSolved: false, latestReplies: [], item: item(ts), ...overrides });

function fixture() {
  let sequence = 0;
  let locked = false;
  const deliveries: ReminderDelivery[] = [];
  const snapshots = new Map<string, ReminderItem>();
  const actions = new Map<string, ReminderAction>();
  const recent = new Set<string>();
  const messages = new Map<string, { destination: ReminderDestination; items: ReminderItem[] }>();
  const operations: Array<{ operation: string; channelId?: string; deliveryTs?: string; items?: string[] }> = [];
  let failPost = false;
  let failPostNumber = 0;
  let postCount = 0;
  const key = (row: { channelId: string; deliveryTs: string }) => `${row.channelId}/${row.deliveryTs}`;
  const snapshotKey = (source: string, ts: string) => `${source}/${ts}`;
  const store: ReminderStore = {
    async withLock(run) {
      if (locked) throw new Error("busy");
      locked = true;
      try { return await run(); } finally { locked = false; }
    },
    async listDeliveries(source) { return deliveries.filter((row) => row.sourceChannelId === source).map((row) => ({ ...row, item: snapshots.get(snapshotKey(source, row.threadTs)) ?? row.item })); },
    async saveThreads(source, items) { for (const value of items) snapshots.set(snapshotKey(source, value.ts), value); },
    async getThread(source, ts) { return snapshots.get(snapshotKey(source, ts)) ?? null; },
    async recordDeliveries(rows) { deliveries.push(...rows); },
    async removeDeliveryItems(rows) {
      for (const row of rows) {
        const index = deliveries.findIndex((candidate) => key(candidate) === key(row) && candidate.sourceChannelId === row.sourceChannelId && candidate.threadTs === row.threadTs);
        if (index >= 0) deliveries.splice(index, 1);
      }
    },
    async pruneThreads(source, active) {
      for (const key of snapshots.keys()) {
        if (key.startsWith(`${source}/`) && !active.some((ts) => key === snapshotKey(source, ts)) && !deliveries.some((row) => snapshotKey(row.sourceChannelId, row.threadTs) === key)) snapshots.delete(key);
      }
    },
    async getActions(tss) { return new Map(tss.flatMap((ts) => actions.has(ts) ? [[ts, actions.get(ts)!]] : [])); },
    async saveAction(ts, _channel, action, _actor, assignee) { actions.set(ts, { action, assigneeUserId: assignee ?? null, actionedAt: new Date(3000_000) }); },
    async release(ts) { actions.delete(ts); recent.delete(ts); },
    async recentlyNagged(tss) { return new Set(tss.filter((ts) => recent.has(ts))); },
    async recordNag(ts) { recent.add(ts); },
  };
  const transport: ReminderTransport = {
    async post(destination, items) {
      postCount += 1;
      if (failPost || failPostNumber === postCount) throw new Error("Slack unavailable");
      const channelId = destination.kind === "assignment_dm" ? `D_${destination.recipientUserId}` : destination.channelId!;
      const deliveryTs = `${++sequence}.000001`;
      messages.set(`${channelId}/${deliveryTs}`, { destination, items: [...items] });
      operations.push({ operation: "post", channelId, deliveryTs, items: items.map((value) => value.ts) });
      return [{ channelId, deliveryTs, items }];
    },
    async update(row, items) {
      if (!messages.has(key(row))) return false;
      messages.set(key(row), { destination: { kind: row.kind, channelId: row.channelId, recipientUserId: row.recipientUserId }, items });
      operations.push({ operation: "update", channelId: row.channelId, deliveryTs: row.deliveryTs, items: items.map((value) => value.ts) });
      return true;
    },
    async delete(row) { messages.delete(key(row)); operations.push({ operation: "delete", channelId: row.channelId, deliveryTs: row.deliveryTs }); },
    async fetchThread(_source, ts) { operations.push({ operation: "fetch" }); return item(ts); },
    async removeLegacyItem(channelId, deliveryTs, ts) { operations.push({ operation: "legacy", channelId, deliveryTs, items: [ts] }); },
  };
  function seed(kind: ReminderDelivery["kind"], tss: string[], recipient: string | null = null, source = SOURCE, channelId = kind === "assignment_dm" ? `D_${recipient}` : TARGET) {
    const deliveryTs = `${++sequence}.000001`;
    const rows = tss.map((ts) => ({ kind, channelId, deliveryTs, sourceChannelId: source, threadTs: ts, recipientUserId: recipient, item: item(ts) }));
    deliveries.push(...rows);
    for (const row of rows) snapshots.set(snapshotKey(source, row.threadTs), row.item);
    messages.set(`${channelId}/${deliveryTs}`, { destination: { kind, channelId, recipientUserId: recipient }, items: rows.map((row) => row.item) });
    return rows;
  }
  const manager = createReminderManager(store, transport);
  const scan = (threads: ScannedThread[], force = false) => manager.reconcile({ sourceChannelId: SOURCE, targetChannelId: TARGET, threads, team: TEAM, roster: [], reNagHours: 168, force });
  const act = (row: ReminderDelivery, action: "suppressed" | "assigned" | "released", assignee?: string) => manager.act({ sourceChannelId: row.sourceChannelId, threadTs: row.threadTs, action, actor: "U_TEAM", assignee, roster: [], clicked: { channelId: row.channelId, deliveryTs: row.deliveryTs, blocks: [] } });
  return { manager, scan, act, seed, deliveries, snapshots, actions, recent, messages, operations, store, setFailPost: (value: boolean) => { failPost = value; }, failAtPost: (value: number) => { failPostNumber = value; } };
}

void test("handling wins over assignment; stale assignment reopens to channel", () => {
  const assignment = { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) };
  assert.deepEqual(routeThread(thread("1000.000001", { parentSolved: true }), TEAM, assignment), { kind: "handled" });
  assert.deepEqual(routeThread(thread("1000.000001"), TEAM, assignment), { kind: "assignment_dm", recipientUserId: "U_TEAM" });
  assert.deepEqual(routeThread(thread("1000.000001", { latestReplies: [{ ts: 4000, user: "U_ASKER", solved: false }] }), TEAM, assignment), { kind: "channel_digest" });
  assert.deepEqual(routeThread(thread("1000.000001", { latestReplies: [{ ts: 2000, user: "U_TEAM", solved: false }] }), TEAM, assignment), { kind: "handled" });
});

void test("resolving bottom assigned item removes all its copies but preserves sibling", async () => {
  const f = fixture();
  const [older, newer] = f.seed("assignment_dm", ["1000.000001", "2000.000002"], "U_TEAM");
  f.seed("channel_digest", [newer.threadTs, "1500.000001"]);
  await f.act(newer, "suppressed");
  assert.deepEqual(f.deliveries.map((row) => row.threadTs).sort(), [older.threadTs, "1500.000001"].sort());
  assert.equal(f.messages.size, 2);
  assert.equal(f.actions.get(newer.threadTs)?.action, "suppressed");
  assert.equal(f.operations.some((operation) => operation.operation === "legacy"), false);
});

void test("channel refresh does not delete, rerender as channel, or duplicate assignment DM", async () => {
  const f = fixture();
  const [assigned] = f.seed("assignment_dm", ["1000.000001"], "U_TEAM");
  f.actions.set(assigned.threadTs, { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) });
  f.recent.add(assigned.threadTs);
  f.seed("channel_digest", ["1500.000001"]);
  await f.scan([thread(assigned.threadTs), thread("1500.000001"), thread("2000.000002")]);
  assert.equal(f.operations.some((operation) => operation.operation === "delete" && operation.channelId === assigned.channelId), false);
  assert.equal(f.messages.get(`${assigned.channelId}/${assigned.deliveryTs}`)?.destination.kind, "assignment_dm");
  assert.equal(f.deliveries.filter((row) => row.kind === "assignment_dm").length, 1);
});

void test("reaction handles assigned thread and cleans both channel and DM copies", async () => {
  const f = fixture();
  const ts = "1000.000001";
  f.seed("assignment_dm", [ts], "U_TEAM");
  f.seed("channel_digest", [ts]);
  f.actions.set(ts, { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) });
  await f.scan([thread(ts, { parentSolved: true })]);
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.messages.size, 0);
  assert.equal(f.operations.some((operation) => operation.operation === "post"), false);
});

void test("DM-to-DM reassignment preserves canonical preview and old recipient's sibling", async () => {
  const f = fixture();
  const [sibling, moved] = f.seed("assignment_dm", ["1000.000001", "2000.000002"], "U_OLD");
  await f.act(moved, "assigned", "U_NEW");
  const target = f.deliveries.find((row) => row.recipientUserId === "U_NEW");
  assert.deepEqual(target?.item, moved.item);
  assert.equal(f.deliveries.some((row) => row.threadTs === moved.threadTs && row.recipientUserId === "U_OLD"), false);
  assert.equal(f.deliveries.some((row) => row.threadTs === sibling.threadTs && row.recipientUserId === "U_OLD"), true);
  assert.equal(f.actions.get(moved.threadTs)?.assigneeUserId, "U_NEW");
});

void test("assigning a second thread consolidates recipient DM; repeating reminders leaves one live message", async () => {
  const f = fixture();
  const [first, second] = f.seed("channel_digest", ["1000.000001", "2000.000002"]);
  await f.act(first, "assigned", "U_TEAM");
  await f.act(second, "assigned", "U_TEAM");
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries.length, 2);
  await f.scan([thread(first.threadTs), thread(second.threadTs)], true);
  await f.scan([thread(first.threadTs), thread(second.threadTs)], true);
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries.length, 2);
  assert.ok(f.deliveries.every((row) => row.kind === "assignment_dm"));
});

void test("release preserves sibling and clears cooldown so thread returns to channel", async () => {
  const f = fixture();
  const [released, sibling] = f.seed("assignment_dm", ["1000.000001", "2000.000002"], "U_TEAM");
  f.recent.add(released.threadTs);
  f.actions.set(released.threadTs, { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) });
  await f.act(released, "released");
  assert.equal(f.recent.has(released.threadTs), false);
  assert.equal(f.deliveries.some((row) => row.threadTs === sibling.threadTs), true);
  await f.scan([thread(released.threadTs)]);
  assert.equal(f.deliveries.find((row) => row.threadTs === released.threadTs)?.kind, "channel_digest");
});

void test("old untracked assignment can be reassigned using Slack preview fallback", async () => {
  const f = fixture();
  const ts = "1000.000001";
  await f.manager.act({ sourceChannelId: SOURCE, threadTs: ts, action: "assigned", actor: "U_TEAM", assignee: "U_NEW", roster: [], clicked: { channelId: "D_OLD", deliveryTs: "99.000001", blocks: [] } });
  assert.deepEqual(f.deliveries[0]?.item, item(ts));
  assert.deepEqual(f.operations.map((operation) => operation.operation), ["fetch", "post", "legacy"]);
});

void test("untracked active assignment gets tracked even within old cooldown", async () => {
  const f = fixture();
  const ts = "1000.000001";
  f.actions.set(ts, { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) });
  f.recent.add(ts);
  await f.scan([thread(ts)]);
  assert.equal(f.deliveries[0]?.kind, "assignment_dm");
  assert.equal(f.operations.some((operation) => operation.operation === "legacy"), false);
});

void test("failed replacement post preserves old visible message and tracking", async () => {
  const f = fixture();
  const [old] = f.seed("channel_digest", ["1000.000001"]);
  f.setFailPost(true);
  await assert.rejects(f.scan([thread(old.threadTs)]), /Slack unavailable/);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.messages.size, 1);
  assert.equal(f.operations.some((operation) => operation.operation === "delete"), false);
});

void test("successful chunks remain tracked if a later Slack post fails", async () => {
  const f = fixture();
  f.seed("channel_digest", ["1000.000001"]);
  f.failAtPost(2);
  const threads = Array.from({ length: MAX_REMINDER_ITEMS + 1 }, (_, index) => thread(`${1000 + index}.000001`));
  await assert.rejects(f.scan(threads), /Slack unavailable/);
  assert.equal(f.deliveries.length, MAX_REMINDER_ITEMS + 1);
  assert.equal(f.messages.size, 2);
  assert.equal(f.operations.some((operation) => operation.operation === "delete"), false);
});

void test("cleanup is source/destination scoped, including equal delivery timestamps in other channels", async () => {
  const f = fixture();
  const [ours] = f.seed("channel_digest", ["1000.000001"]);
  const [other] = f.seed("channel_digest", ["1000.000001"], null, "C_OTHER_SOURCE", "C_OTHER_DEST");
  other.deliveryTs = ours.deliveryTs;
  await f.scan([]);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0]?.sourceChannelId, "C_OTHER_SOURCE");
});

void test("deleted Slack DM retires stale pointer and is repaired on the next scan", async () => {
  const f = fixture();
  const [row] = f.seed("assignment_dm", ["1000.000001"], "U_TEAM");
  f.actions.set(row.threadTs, { action: "assigned", assigneeUserId: "U_TEAM", actionedAt: new Date(3000_000) });
  f.recent.add(row.threadTs);
  f.messages.delete(`${row.channelId}/${row.deliveryTs}`);
  await f.scan([thread(row.threadTs)]);
  assert.equal(f.deliveries.length, 0);
  await f.scan([thread(row.threadTs)]);
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries.length, 1);
});

void test("failed assignment delivery preserves old copy; later scan repairs destination despite cooldown", async () => {
  const f = fixture();
  const [row] = f.seed("assignment_dm", ["1000.000001"], "U_OLD");
  f.recent.add(row.threadTs);
  f.setFailPost(true);
  await assert.rejects(f.act(row, "assigned", "U_NEW"), /Slack unavailable/);
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries[0]?.recipientUserId, "U_OLD");
  f.setFailPost(false);
  await f.scan([thread(row.threadTs)]);
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries[0]?.recipientUserId, "U_NEW");
});

void test("resolved orphan previews are pruned while active snapshots remain", async () => {
  const f = fixture();
  f.seed("channel_digest", ["1000.000001", "2000.000002"]);
  await f.scan([thread("1000.000001", { parentSolved: true }), thread("2000.000002")]);
  assert.equal(f.snapshots.has(`${SOURCE}/1000.000001`), false);
  assert.equal(f.snapshots.has(`${SOURCE}/2000.000002`), true);
});

void test("retrying assignment after original entry disappeared does not post a duplicate DM", async () => {
  const f = fixture();
  const [row] = f.seed("channel_digest", ["1000.000001"]);
  await f.act(row, "assigned", "U_TEAM");
  await f.act(row, "assigned", "U_TEAM");
  assert.equal(f.operations.filter((operation) => operation.operation === "post").length, 1);
  assert.equal(f.messages.size, 1);
  assert.equal(f.deliveries.length, 1);
});

void test("retrying a removed entry in a known message never rebuilds stale sibling blocks", async () => {
  const f = fixture();
  const [_sibling, row] = f.seed("assignment_dm", ["1000.000001", "2000.000002"], "U_TEAM");
  await f.act(row, "suppressed");
  await f.act(row, "suppressed");
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.operations.filter((operation) => operation.operation === "update").length, 1);
  assert.equal(f.operations.some((operation) => operation.operation === "legacy"), false);
});

void test("recipient consolidation respects current assignment state instead of stale delivery pointers", async () => {
  const f = fixture();
  const [stale] = f.seed("assignment_dm", ["1000.000001"], "U_TEAM");
  f.actions.set(stale.threadTs, { action: "assigned", assigneeUserId: "U_OTHER", actionedAt: new Date(3000_000) });
  const [newItem] = f.seed("channel_digest", ["2000.000002"]);
  await f.act(newItem, "assigned", "U_TEAM");
  const posted = f.operations.find((operation) => operation.operation === "post");
  assert.deepEqual(posted?.items, [newItem.threadTs]);
  await f.scan([thread(stale.threadTs), thread(newItem.threadTs)]);
  assert.equal(f.deliveries.find((row) => row.threadTs === stale.threadTs)?.recipientUserId, "U_OTHER");
});

void test("release from an old DM cannot erase a newer suppression", async () => {
  const f = fixture();
  const [row] = f.seed("assignment_dm", ["1000.000001"], "U_TEAM");
  f.actions.set(row.threadTs, { action: "suppressed", assigneeUserId: null, actionedAt: new Date(3000_000) });
  f.recent.add(row.threadTs);
  await f.act(row, "released");
  assert.equal(f.actions.get(row.threadTs)?.action, "suppressed");
  assert.equal(f.recent.has(row.threadTs), true);
  assert.equal(f.deliveries.length, 0);
});
