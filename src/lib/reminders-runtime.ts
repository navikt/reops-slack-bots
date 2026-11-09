import { and, eq, notInArray, or, sql } from "drizzle-orm";
import { getDb, getPool, getRecentlyNaggedTs, getThreadActions, upsertNagLog, upsertThreadAction } from "./db";
import { nagLog, reminderDeliveries, reminderThreads, threadActions } from "./schema";
import { createReminderManager, type ReminderDelivery, type ReminderItem, type ReminderStore, type ReminderTransport } from "./reminders";
import { deleteReminderMessage, fetchReminderThread, postReminderMessages, removeItemFromSlackMessage, updateReminderDelivery } from "./slack";
import { type MessageBlock } from "./digest-item-removal";
import { logError } from "./log";

function itemFromRow(row: typeof reminderThreads.$inferSelect): ReminderItem {
  return { ts: row.threadTs, permalink: row.permalink, text: row.textExcerpt, authorLabel: row.authorLabel, imageUrl: row.imageUrl };
}

export const reminderStore: ReminderStore = {
  async withLock(run) {
    // Try rather than wait while occupying the app's small DB pool. Concurrent
    // scans/actions retry on their next invocation; never race Slack rewrites.
    const client = await getPool().connect();
    let locked = false;
    try {
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", ["reops-slack-bots.reminders.v1"],
      );
      locked = result.rows[0]?.locked === true;
      if (!locked) throw new Error("Reminder update already in progress; retry shortly");
      return await run();
    } finally {
      try {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["reops-slack-bots.reminders.v1"]);
        client.release();
      } catch (err) {
        client.release(true);
        throw err;
      }
    }
  },
  async listDeliveries(sourceChannelId) {
    const rows = await getDb().select({ delivery: reminderDeliveries, thread: reminderThreads })
      .from(reminderDeliveries)
      .innerJoin(reminderThreads, and(eq(reminderThreads.sourceChannelId, reminderDeliveries.sourceChannelId), eq(reminderThreads.threadTs, reminderDeliveries.threadTs)))
      .where(eq(reminderDeliveries.sourceChannelId, sourceChannelId))
      .orderBy(reminderDeliveries.postedAt, reminderDeliveries.threadTs);
    return rows.map(({ delivery, thread }) => ({ ...delivery, kind: delivery.kind as ReminderDelivery["kind"], item: itemFromRow(thread) }));
  },
  async saveThreads(sourceChannelId, items) {
    if (!items.length) return;
    // Deduplicate before upsert: PG disallows updating one row twice in an INSERT.
    const unique = [...new Map(items.map((item) => [item.ts, item])).values()];
    await getDb().insert(reminderThreads).values(unique.map((item) => ({
      sourceChannelId, threadTs: item.ts, permalink: item.permalink, textExcerpt: item.text.slice(0, 500), authorLabel: item.authorLabel, imageUrl: item.imageUrl,
    }))).onConflictDoUpdate({
      target: [reminderThreads.sourceChannelId, reminderThreads.threadTs],
      set: {
        permalink: sqlExcluded("permalink"), textExcerpt: sqlExcluded("text_excerpt"),
        authorLabel: sqlExcluded("author_label"), imageUrl: sqlExcluded("image_url"), updatedAt: new Date(),
      },
    });
  },
  async getThread(sourceChannelId, threadTs) {
    const [row] = await getDb().select().from(reminderThreads)
      .where(and(eq(reminderThreads.sourceChannelId, sourceChannelId), eq(reminderThreads.threadTs, threadTs))).limit(1);
    return row ? itemFromRow(row) : null;
  },
  async recordDeliveries(deliveries) {
    if (!deliveries.length) return;
    await getDb().insert(reminderDeliveries).values(deliveries.map(({ item: _item, ...row }) => row)).onConflictDoNothing();
  },
  async removeDeliveryItems(deliveries) {
    if (!deliveries.length) return;
    await getDb().delete(reminderDeliveries).where(or(...deliveries.map((row) => and(
      eq(reminderDeliveries.channelId, row.channelId), eq(reminderDeliveries.deliveryTs, row.deliveryTs),
      eq(reminderDeliveries.sourceChannelId, row.sourceChannelId), eq(reminderDeliveries.threadTs, row.threadTs),
    ))));
  },
  async pruneThreads(sourceChannelId, activeThreadTss) {
    await getDb().delete(reminderThreads).where(and(
      eq(reminderThreads.sourceChannelId, sourceChannelId),
      activeThreadTss.length ? notInArray(reminderThreads.threadTs, activeThreadTss) : sql`true`,
      sql`NOT EXISTS (SELECT 1 FROM ${reminderDeliveries} WHERE ${reminderDeliveries.sourceChannelId} = ${reminderThreads.sourceChannelId} AND ${reminderDeliveries.threadTs} = ${reminderThreads.threadTs})`,
    ));
  },
  getActions: getThreadActions,
  saveAction: upsertThreadAction,
  async release(threadTs) {
    await getDb().transaction(async (tx) => {
      const removed = await tx.delete(threadActions)
        .where(and(eq(threadActions.messageTs, threadTs), eq(threadActions.action, "assigned")))
        .returning({ messageTs: threadActions.messageTs });
      // A release must re-enter the channel on the next scan, not wait a week.
      if (removed.length) await tx.delete(nagLog).where(eq(nagLog.messageTs, threadTs));
    });
  },
  async unsuppress(threadTs) {
    await getDb().transaction(async (tx) => {
      const removed = await tx.delete(threadActions)
        .where(and(eq(threadActions.messageTs, threadTs), eq(threadActions.action, "suppressed")))
        .returning({ messageTs: threadActions.messageTs });
      if (removed.length) await tx.delete(nagLog).where(eq(nagLog.messageTs, threadTs));
    });
  },
  recentlyNagged: getRecentlyNaggedTs,
  recordNag: upsertNagLog,
};

// Fixed column names only, never constructed from request input.
function sqlExcluded(column: "permalink" | "text_excerpt" | "author_label" | "image_url") {
  return sql.raw(`excluded."${column}"`);
}

const reminderTransport: ReminderTransport = {
  post: postReminderMessages,
  update: updateReminderDelivery,
  delete: (row) => deleteReminderMessage(row.channelId, row.deliveryTs),
  fetchThread: fetchReminderThread,
  async removeLegacyItem(channelId, deliveryTs, threadTs, blocks) {
    const updated = await removeItemFromSlackMessage(channelId, deliveryTs, threadTs, blocks as MessageBlock[]);
    if (!updated) logError({ event: "slack.legacy_reminder_unchanged", channel: channelId, ts: deliveryTs, thread_ts: threadTs, reason: "unknown_message_layout" });
  },
};

export const reminders = createReminderManager(reminderStore, reminderTransport);

/** Derive source from tracked delivery, never from the destination's type. */
export async function sourceForReminder(channelId: string, deliveryTs: string, threadTs: string): Promise<string | null> {
  const [row] = await getDb().select({ sourceChannelId: reminderDeliveries.sourceChannelId })
    .from(reminderDeliveries)
    .where(and(eq(reminderDeliveries.channelId, channelId), eq(reminderDeliveries.deliveryTs, deliveryTs), eq(reminderDeliveries.threadTs, threadTs))).limit(1);
  return row?.sourceChannelId ?? null;
}
