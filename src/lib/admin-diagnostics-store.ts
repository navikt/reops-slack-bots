import { desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { reminderDeliveries, reminderThreads } from "./schema";

/** Bounded diagnostics samples, not a second source of reminder state. */
export async function diagnosticTracking() {
  const [snapshots, deliveries] = await Promise.all([
    getDb()
      .select()
      .from(reminderThreads)
      .orderBy(desc(reminderThreads.updatedAt))
      .limit(200),
    getDb()
      .select()
      .from(reminderDeliveries)
      .orderBy(desc(reminderDeliveries.postedAt))
      .limit(400),
  ]);
  return { snapshots, deliveries };
}

export async function diagnosticThreadSources(
  threadTs: string,
): Promise<string[]> {
  const snapshots = await getDb()
    .select({ source: reminderThreads.sourceChannelId })
    .from(reminderThreads)
    .where(eq(reminderThreads.threadTs, threadTs))
    .limit(3);
  return snapshots.map((row) => row.source);
}
