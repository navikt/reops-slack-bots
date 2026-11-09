import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createReminderManager, type ReminderDelivery, type ReminderItem, type ReminderTransport } from "./reminders.ts";

const testUrl = process.env.REMINDER_TEST_DATABASE_URL;

void test("unified reminder migration and DB adapter preserve legacy state", { skip: !testUrl }, async (t) => {
  // Never default to DATABASE_URL: this test creates/drops disposable databases.
  const parsed = new URL(testUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(parsed.hostname), "Integration DB must be local");
  assert.notEqual(parsed.port || "5432", "5432", "Use a dedicated test Postgres port, not your dev/proxy DB");
  assert.ok(!process.env.NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS_URL, "Do not run integration tests with Nais DB env injected");
  const admin = new Pool({ connectionString: testUrl });
  const prefix = `reminder_test_${process.pid}_${Date.now()}`;
  const names = [`${prefix}_fresh`, `${prefix}_legacy`];
  const createdNames: string[] = [];
  const pools: Pool[] = [];
  const migrationsFolder = path.resolve("drizzle");
  const journal = JSON.parse(await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const oldFolder = await mkdtemp(path.join(tmpdir(), "reminder-migrations-"));
  let adapterPool: Pool | undefined;
  const connectionFor = (name: string) => {
    const url = new URL(testUrl!);
    url.pathname = `/${name}`;
    return url.toString();
  };
  try {
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}"`);
      createdNames.push(name);
      pools.push(new Pool({ connectionString: connectionFor(name) }));
    }
    await t.test("fresh installation applies all migrations and reruns safely", async () => {
      const pool = pools[0];
      await migrate(drizzle(pool), { migrationsFolder });
      await migrate(drizzle(pool), { migrationsFolder });
      const res = await pool.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations");
      assert.equal(res.rows[0].n, journal.entries.length);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM reminder_deliveries")).rows[0].n, 0);
    });

    await mkdir(path.join(oldFolder, "meta"));
    const migrationIndex = journal.entries.findIndex((entry) => entry.tag === "0003_unified_reminders");
    assert.ok(migrationIndex >= 0);
    const oldEntries = journal.entries.slice(0, migrationIndex);
    await writeFile(path.join(oldFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
    for (const entry of oldEntries) await copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(oldFolder, `${entry.tag}.sql`));
    const legacy = pools[1];
    await migrate(drizzle(legacy), { migrationsFolder: oldFolder });
    await legacy.query(`
      INSERT INTO settings(key,value) VALUES ('unanswered_reminder.handled_emojis',''), ('unanswered_reminder.source_channel_id','C_SOURCE') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
      INSERT INTO ignore_persons(kind,label,email) VALUES ('person','Fixture team','fixture@example.invalid');
      INSERT INTO ignore_groups(id,kind,label) VALUES ('fixture-team','team','Fixture team');
      INSERT INTO admin_groups(id,kind,label) VALUES ('fixture-admin','team','Fixture admin');
      INSERT INTO admin_persons(nav_ident,label) VALUES ('Z000000','Fixture admin');
      INSERT INTO nag_log(message_ts,channel_id,last_nagged_at) VALUES ('1000.000001','C_TEAM','2026-11-01'), ('2000.000002','D_TEAM','2026-11-02');
      INSERT INTO thread_actions(message_ts,channel_id,action,actor_user_id,assignee_user_id,actioned_at) VALUES
        ('1000.000001','C_TEAM','suppressed','U_TEAM',NULL,'2026-11-01'),
        ('2000.000002','C_TEAM','assigned','U_TEAM','U_ASSIGNEE','2026-11-02');
      INSERT INTO digest_messages(digest_ts,channel_id,message_ts,source_channel_id,permalink,text_excerpt,author_label,image_url,posted_at) VALUES
        ('5000.000001','C_TEAM','1000.000001','C_SOURCE','https://example.invalid/old','Old preview','Old author',NULL,'2026-11-01'),
        ('6000.000001','C_TEAM','1000.000001','C_SOURCE','https://example.invalid/new','Current preview','Asker',NULL,'2026-11-02'),
        ('6000.000001','C_TEAM','2000.000002','C_SOURCE','https://example.invalid/assigned','Assigned preview','Asker','https://example.invalid/image','2026-11-02');
    `);
    const legacyTables = ["settings", "ignore_persons", "ignore_groups", "admin_groups", "admin_persons", "nag_log", "thread_actions", "digest_messages"];
    const before = await Promise.all(legacyTables.map(async (table) => (await legacy.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows));

    await t.test("populated migration preserves every legacy row and backfills latest shared previews", async () => {
      await migrate(drizzle(legacy), { migrationsFolder });
      await migrate(drizzle(legacy), { migrationsFolder });
      for (const [index, table] of legacyTables.entries()) {
        assert.deepEqual((await legacy.query(`SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY to_jsonb(t)::text`)).rows, before[index], `${table} changed`);
      }
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM reminder_deliveries")).rows[0].n, 3);
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM reminder_threads")).rows[0].n, 2);
      const preview = (await legacy.query("SELECT * FROM reminder_threads WHERE thread_ts='1000.000001'")).rows[0];
      assert.equal(preview.text_excerpt, "Current preview");
      assert.equal(preview.permalink, "https://example.invalid/new");
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM reminder_deliveries WHERE kind <> 'channel_digest'")).rows[0].n, 0);
      await assert.rejects(legacy.query("INSERT INTO reminder_deliveries(channel_id,delivery_ts,source_channel_id,thread_ts,kind) VALUES ('D_BAD','1.0','C_SOURCE','1000.000001','assignment_dm')"), /check constraint/);
      const plan = await legacy.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM reminder_deliveries WHERE source_channel_id='C_SOURCE' AND thread_ts='1000.000001'");
      assert.ok(plan.rows[0]["QUERY PLAN"][0].Plan);
    });

    await t.test("real DB adapter shares previews and preserves sibling deliveries during reassign/suppress", async () => {
      process.env.DATABASE_URL = connectionFor(names[1]);
      const { reminderStore } = await import("./reminders-runtime.ts");
      const { getPool } = await import("./db.ts");
      adapterPool = getPool();
      let nextTs = 7000;
      const operations: Array<{ operation: string; channelId: string; items?: ReminderItem[] }> = [];
      const transport: ReminderTransport = {
        async post(destination, items) {
          const channelId = destination.kind === "assignment_dm" ? `D_${destination.recipientUserId}` : destination.channelId!;
          operations.push({ operation: "post", channelId, items });
          return [{ channelId, deliveryTs: `${++nextTs}.000001`, items }];
        },
        async update(row, items) { operations.push({ operation: "update", channelId: row.channelId, items }); return true; },
        async delete(row) { operations.push({ operation: "delete", channelId: row.channelId }); },
        async fetchThread() { throw new Error("Shared DB preview should be available"); },
        async removeLegacyItem() { throw new Error("Tracked click should not use payload fallback"); },
      };
      const manager = createReminderManager(reminderStore, transport);
      const existing = await reminderStore.listDeliveries("C_SOURCE");
      const assignedPreview = await reminderStore.getThread("C_SOURCE", "2000.000002");
      assert.ok(assignedPreview);
      const dm: ReminderDelivery = { sourceChannelId: "C_SOURCE", threadTs: "2000.000002", channelId: "D_OLD", deliveryTs: "8000.000001", kind: "assignment_dm", recipientUserId: "U_OLD", item: assignedPreview };
      await reminderStore.recordDeliveries([dm]);
      await manager.act({ sourceChannelId: "C_SOURCE", threadTs: dm.threadTs, action: "assigned", actor: "U_TEAM", assignee: "U_NEW", roster: [], clicked: { channelId: dm.channelId, deliveryTs: dm.deliveryTs, blocks: [] } });
      assert.deepEqual(operations.find((op) => op.operation === "post")?.items, [assignedPreview]);
      const afterAssign = await reminderStore.listDeliveries("C_SOURCE");
      assert.equal(afterAssign.filter((row) => row.threadTs === dm.threadTs).length, 1);
      assert.equal(afterAssign.find((row) => row.threadTs === dm.threadTs)?.recipientUserId, "U_NEW");
      assert.equal(afterAssign.filter((row) => row.threadTs === "1000.000001").length, 2);
      const moved = afterAssign.find((row) => row.threadTs === dm.threadTs)!;
      await manager.act({ sourceChannelId: "C_SOURCE", threadTs: dm.threadTs, action: "suppressed", actor: "U_NEW", roster: [], clicked: { channelId: moved.channelId, deliveryTs: moved.deliveryTs, blocks: [] } });
      assert.equal((await reminderStore.listDeliveries("C_SOURCE")).length, 2);
      assert.equal((await legacy.query("SELECT action FROM thread_actions WHERE message_ts=$1", [dm.threadTs])).rows[0].action, "suppressed");
      assert.equal(existing.length, 3);

      await reminderStore.unsuppress(dm.threadTs);
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM thread_actions WHERE message_ts=$1", [dm.threadTs])).rows[0].n, 0);
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM nag_log WHERE message_ts=$1", [dm.threadTs])).rows[0].n, 0);
      await reminderStore.saveAction(dm.threadTs, "C_SOURCE", "assigned", "U_NEW", "U_NEW");
      await reminderStore.recordNag(dm.threadTs, "D_NEW");
      await reminderStore.unsuppress(dm.threadTs);
      assert.equal((await legacy.query("SELECT action FROM thread_actions WHERE message_ts=$1", [dm.threadTs])).rows[0].action, "assigned");
      assert.equal((await legacy.query("SELECT count(*)::int AS n FROM nag_log WHERE message_ts=$1", [dm.threadTs])).rows[0].n, 1);

      // Lock contention is rejected without consuming every pool connection.
      let unlock!: () => void;
      const barrier = new Promise<void>((resolve) => { unlock = resolve; });
      let entered!: () => void;
      const acquired = new Promise<void>((resolve) => { entered = resolve; });
      const first = reminderStore.withLock(async () => { entered(); await barrier; });
      await acquired;
      try {
        await assert.rejects(reminderStore.withLock(async () => undefined), /already in progress/);
      } finally { unlock(); await first; }
    });
  } finally {
    await adapterPool?.end();
    for (const pool of pools) await pool.end();
    for (const name of createdNames) await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    await rm(oldFolder, { recursive: true, force: true });
  }
});
