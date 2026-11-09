import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Hand-written to match the production schema exactly (names, types,
 * nullability, PKs, defaults, CHECK constraints). The baseline migration in
 * drizzle/0000_*.sql captures this shape.
 *
 * Naming convention: <scope>_<entity> — `ignore_*` is who the bot skips,
 * `admin_*` is who may use /admin; `persons` are individuals, `groups` are
 * Team Catalog groups.
 */

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const ignorePersons = pgTable(
  "ignore_persons",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    label: text("label"),
    navIdent: text("nav_ident"),
    email: text("email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [check("ignore_persons_kind_check", sql`${t.kind} IN ('person')`)],
);

export const ignoreGroups = pgTable(
  "ignore_groups",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.kind] }),
    check("ignore_groups_kind_check", sql`${t.kind} IN ('team', 'cluster', 'productarea')`),
  ],
);

export const adminGroups = pgTable(
  "admin_groups",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.kind] }),
    check("admin_groups_kind_check", sql`${t.kind} IN ('team', 'cluster', 'productarea')`),
  ],
);

export const adminPersons = pgTable("admin_persons", {
  navIdent: text("nav_ident").primaryKey(),
  label: text("label"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

export const nagLog = pgTable("nag_log", {
  messageTs: text("message_ts").primaryKey(),
  channelId: text("channel_id").notNull(),
  lastNaggedAt: timestamp("last_nagged_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * Manual per-thread marks from the digest's Suppress button. A thread is
 * handled when actioned_at >= its last reply ts (see thread-handled.ts) —
 * later thread activity re-opens it. Kept separate from nag_log: nag_log is
 * "when did we last remind", thread_actions is "a human marked this".
 */
export const threadActions = pgTable("thread_actions", {
  messageTs: text("message_ts").primaryKey(),
  channelId: text("channel_id").notNull(),
  action: text("action").notNull(), // 'suppressed' | 'assigned'
  actorUserId: text("actor_user_id").notNull(), // Slack UID of button presser
  /** Set when action = 'assigned' — who now owns the thread. */
  assigneeUserId: text("assignee_user_id"),
  actionedAt: timestamp("actioned_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});

/**
 * Legacy channel-only delivery ledger. Kept for additive migration and schema
 * compatibility; the new runtime uses reminder_threads/reminder_deliveries.
 * Never add new writers here or use this table as current thread state.
 */
export const digestMessages = pgTable(
  "digest_messages",
  {
    digestTs: text("digest_ts").notNull(), // ts of the posted digest message
    channelId: text("channel_id").notNull(), // digest (target) channel
    messageTs: text("message_ts").notNull(), // the unanswered thread it links to
    sourceChannelId: text("source_channel_id").notNull(), // where the thread lives
    /** Link as posted (usually the thread's LATEST reply, not the parent). */
    permalink: text("permalink").notNull(),
    /** Rendering data, so digests can be rebuilt without a fresh scan. */
    textExcerpt: text("text_excerpt").notNull(),
    authorLabel: text("author_label").notNull(), // display name or Slack UID
    imageUrl: text("image_url"), // nullable — most replies have no image
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  // One digest message carries up to 5 threads.
  (t) => [primaryKey({ columns: [t.digestTs, t.messageTs] })],
);

/** Shared preview cache; neither a delivery nor a handled-state override. */
export const reminderThreads = pgTable(
  "reminder_threads",
  {
    sourceChannelId: text("source_channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    permalink: text("permalink").notNull(),
    textExcerpt: text("text_excerpt").notNull(),
    authorLabel: text("author_label").notNull(),
    imageUrl: text("image_url"),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sourceChannelId, t.threadTs] })],
);

/** Every rendered copy, regardless of channel digest vs assignment DM. */
export const reminderDeliveries = pgTable(
  "reminder_deliveries",
  {
    channelId: text("channel_id").notNull(),
    deliveryTs: text("delivery_ts").notNull(),
    sourceChannelId: text("source_channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    kind: text("kind").notNull(),
    recipientUserId: text("recipient_user_id"),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.deliveryTs, t.sourceChannelId, t.threadTs] }),
    foreignKey({ columns: [t.sourceChannelId, t.threadTs], foreignColumns: [reminderThreads.sourceChannelId, reminderThreads.threadTs] }),
    index("reminder_deliveries_thread_idx").on(t.sourceChannelId, t.threadTs),
    check("reminder_deliveries_destination_check", sql`(${t.kind} = 'channel_digest' AND ${t.recipientUserId} IS NULL) OR (${t.kind} = 'assignment_dm' AND ${t.recipientUserId} IS NOT NULL)`),
  ],
);

export type Setting = typeof settings.$inferSelect;
export type IgnorePerson = typeof ignorePersons.$inferSelect;
export type IgnoreGroup = typeof ignoreGroups.$inferSelect;
export type AdminGroup = typeof adminGroups.$inferSelect;
export type AdminPerson = typeof adminPersons.$inferSelect;
export type NagLogEntry = typeof nagLog.$inferSelect;
export type ThreadAction = typeof threadActions.$inferSelect;
export type DigestMessage = typeof digestMessages.$inferSelect;
