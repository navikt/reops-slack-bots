import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { readFileSync } from "node:fs";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { adminGroups, adminPersons, digestMessages, ignoreGroups, ignorePersons, nagLog, settings, threadActions } from "./schema";

let pool: Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;

/**
 * Connection config. On Nais we get NAIS_DATABASE_<APP>_<DB>_* injected:
 * _URL is a ready postgresql:// string, and the instance requires
 * verify-ca with the mounted sqeletor certs (paths in _SSLROOTCERT/_SSLKEY
 * /_SSLCERT — use the PEM key; the _PK8 variant is DER, which Node TLS
 * rejects with "DECODER routines::unsupported"). Locally, fall back to a plain
 * postgres:// DATABASE_URL from .env.local. The JDBC URL variant Nais also
 * injects is NOT usable by pg (JDBC syntax + sslmode).
 */
function connectionConfig(): Record<string, unknown> {
  const prefix = "NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS";
  const naisUrl = process.env[`${prefix}_URL`];
  if (naisUrl) {
    const sslRootCert = process.env[`${prefix}_SSLROOTCERT`];
    const sslKey = process.env[`${prefix}_SSLKEY`]; // PEM — the _PK8 variant is DER, which Node TLS rejects
    const sslCert = process.env[`${prefix}_SSLCERT`];
    return {
      connectionString: naisUrl.split("?")[0],
      ssl:
        sslRootCert && sslKey && sslCert
          ? {
              // Cloud SQL's server cert carries the instance DNS name in its
              // SAN, but _URL hands us the IP — hostname check would always
              // fail. CA-chain verification + client certs still authenticate
              // both ends (standard Cloud SQL client behavior).
              rejectUnauthorized: true,
              checkServerIdentity: () => undefined,
              ca: readFileSync(sslRootCert, "utf-8"),
              key: readFileSync(sslKey, "utf-8"),
              cert: readFileSync(sslCert, "utf-8"),
            }
          : false,
    };
  }

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) throw new Error("DATABASE_URL is not set");
  return { connectionString: rawUrl };
}

export function getPool(): Pool {
  if (pool) return pool;

  pool = new Pool({
    ...connectionConfig(),
    max: 5,
  });

  pool.on("error", (err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: "db.pool_error", message: err.message }));
  });

  return pool;
}

/** Drizzle instance over the shared pool. Import schema tables from
 * src/lib/schema.ts directly; this is for query-builder access. */
export function getDb(): NodePgDatabase<typeof schema> {
  if (db) return db;
  db = drizzle(getPool(), { schema });
  return db;
}

/** Raw-SQL escape hatch for the few non-CRUD uses. Prefer getDb(). */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const rows = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export interface IgnorePersonRow {
  id: number;
  kind: "person";
  label: string | null;
  nav_ident: string | null;
  email: string;
  created_at: Date;
}

function toIgnorePersonRow(r: typeof ignorePersons.$inferSelect): IgnorePersonRow {
  return {
    id: r.id,
    kind: r.kind as IgnorePersonRow["kind"],
    label: r.label,
    nav_ident: r.navIdent,
    email: r.email,
    created_at: r.createdAt,
  };
}

export async function listIgnorePersons(): Promise<IgnorePersonRow[]> {
  const rows = await getDb()
    .select()
    .from(ignorePersons)
    .orderBy(asc(ignorePersons.createdAt));
  return rows.map(toIgnorePersonRow);
}

export async function addIgnorePerson(
  email: string,
  label: string | null,
  navIdent: string | null,
): Promise<IgnorePersonRow> {
  const rows = await getDb()
    .insert(ignorePersons)
    .values({ kind: "person", label, navIdent, email })
    .returning();
  return toIgnorePersonRow(rows[0]);
}

export async function removeIgnorePerson(id: number): Promise<boolean> {
  const rows = await getDb()
    .delete(ignorePersons)
    .where(eq(ignorePersons.id, id))
    .returning({ id: ignorePersons.id });
  return rows.length > 0;
}

export async function listIgnoreEmails(): Promise<string[]> {
  const rows = await getDb()
    .select({ email: ignorePersons.email })
    .from(ignorePersons)
    .where(eq(ignorePersons.kind, "person"));
  return rows.map((r) => r.email);
}

// ── Ignore groups (Team Catalog) ─────────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  kind: "team" | "cluster" | "productarea";
  label: string;
}

export async function listIgnoreGroups(): Promise<GroupRow[]> {
  const rows = await getDb().select().from(ignoreGroups).orderBy(asc(ignoreGroups.label));
  return rows.map((r) => ({ ...r, kind: r.kind as GroupRow["kind"] }));
}

export async function addIgnoreGroup(id: string, kind: GroupRow["kind"], label: string): Promise<void> {
  await getDb()
    .insert(ignoreGroups)
    .values({ id, kind, label })
    .onConflictDoNothing({ target: [ignoreGroups.id, ignoreGroups.kind] });
}

export async function removeIgnoreGroup(id: string, kind: string): Promise<boolean> {
  const rows = await getDb()
    .delete(ignoreGroups)
    .where(and(eq(ignoreGroups.id, id), eq(ignoreGroups.kind, kind)))
    .returning({ id: ignoreGroups.id });
  return rows.length > 0;
}

// ── Admin groups (Team Catalog groups whose members may use /admin) ──────────

export async function listAdminGroups(): Promise<GroupRow[]> {
  const rows = await getDb().select().from(adminGroups).orderBy(asc(adminGroups.label));
  return rows.map((r) => ({ ...r, kind: r.kind as GroupRow["kind"] }));
}

export async function addAdminGroup(id: string, kind: GroupRow["kind"], label: string): Promise<void> {
  await getDb()
    .insert(adminGroups)
    .values({ id, kind, label })
    .onConflictDoNothing({ target: [adminGroups.id, adminGroups.kind] });
}

export async function removeAdminGroup(id: string, kind: string): Promise<boolean> {
  const rows = await getDb()
    .delete(adminGroups)
    .where(and(eq(adminGroups.id, id), eq(adminGroups.kind, kind)))
    .returning({ id: adminGroups.id });
  return rows.length > 0;
}

// ── Admin persons (nav-ident based) ─────────────────────────────────────

export interface AdminPersonRow {
  nav_ident: string;
  label: string | null;
}

export async function listAdminPersons(): Promise<AdminPersonRow[]> {
  const rows = await getDb()
    .select({ navIdent: adminPersons.navIdent, label: adminPersons.label })
    .from(adminPersons)
    // ORDER BY label ASC NULLS LAST, nav_ident ASC
    .orderBy(sql`${adminPersons.label} ASC NULLS LAST`, asc(adminPersons.navIdent));
  return rows.map((r) => ({ nav_ident: r.navIdent, label: r.label }));
}

export async function addAdminPerson(navIdent: string, label: string | null): Promise<void> {
  await getDb()
    .insert(adminPersons)
    .values({ navIdent, label })
    .onConflictDoNothing({ target: adminPersons.navIdent });
}

export async function removeAdminPerson(navIdent: string): Promise<boolean> {
  const rows = await getDb()
    .delete(adminPersons)
    .where(eq(adminPersons.navIdent, navIdent))
    .returning({ navIdent: adminPersons.navIdent });
  return rows.length > 0;
}

export async function getRecentlyNaggedTs(
  messageTss: string[],
  cooldownHours: number,
): Promise<Set<string>> {
  if (messageTss.length === 0) return new Set();
  const rows = await getDb()
    .select({ messageTs: nagLog.messageTs })
    .from(nagLog)
    .where(
      and(
        inArray(nagLog.messageTs, messageTss),
        sql`${nagLog.lastNaggedAt} > now() - (${String(cooldownHours)} || ' hours')::interval`,
      ),
    );
  return new Set(rows.map((r) => r.messageTs));
}

export async function upsertNagLog(messageTs: string, channelId: string): Promise<void> {
  await getDb()
    .insert(nagLog)
    .values({ messageTs, channelId })
    .onConflictDoUpdate({
      target: nagLog.messageTs,
      set: { lastNaggedAt: new Date(), channelId },
    });
}

// ── Admin DB insight (read-only) ─────────────────────────────────────────────

export async function getNagLogCount(): Promise<number> {
  const rows = await getDb().select({ n: count() }).from(nagLog);
  return rows[0]?.n ?? 0;
}

/**
 * nag_log rows still inside the re-nag cooldown, with the timestamp each
 * becomes eligible again. Drives the admin "suppressed until" diagnostics.
 */
export async function listNagSuppressed(
  cooldownHours: number,
): Promise<Array<{ message_ts: string; channel_id: string; next_eligible_at: Date }>> {
  const rows = await getDb()
    .select({
      messageTs: nagLog.messageTs,
      channelId: nagLog.channelId,
      // sql`` columns come back untyped from pg — timestamptz lands as a
      // string, so map with new Date() below instead of mode:"date".
      nextEligibleAt: sql<string>`${nagLog.lastNaggedAt} + (${String(cooldownHours)} || ' hours')::interval`,
    })
    .from(nagLog)
    .where(sql`${nagLog.lastNaggedAt} > now() - (${String(cooldownHours)} || ' hours')::interval`)
    .orderBy(asc(nagLog.lastNaggedAt));
  return rows.map((r) => ({
    message_ts: r.messageTs,
    channel_id: r.channelId,
    next_eligible_at: new Date(r.nextEligibleAt),
  }));
}

export async function listRecentNagLog(
  limit = 10,
): Promise<Array<{ message_ts: string; channel_id: string; last_nagged_at: Date }>> {
  const rows = await getDb()
    .select()
    .from(nagLog)
    .orderBy(desc(nagLog.lastNaggedAt))
    .limit(limit);
  return rows.map((r) => ({
    message_ts: r.messageTs,
    channel_id: r.channelId,
    last_nagged_at: r.lastNaggedAt,
  }));
}

/** Row counts for the app's tables. Static table list — no user input. */
export async function getTableCounts(): Promise<Array<{ table: string; rows: number }>> {
  const tables = [
    ["settings", settings],
    ["ignore_persons", ignorePersons],
    ["ignore_groups", ignoreGroups],
    ["admin_groups", adminGroups],
    ["admin_persons", adminPersons],
    ["nag_log", nagLog],
    ["thread_actions", threadActions],
    ["digest_messages", digestMessages],
  ] as const;
  const out: Array<{ table: string; rows: number }> = [];
  for (const [name, table] of tables) {
    const rows = await getDb().select({ n: count() }).from(table);
    out.push({ table: name, rows: rows[0]?.n ?? 0 });
  }
  return out;
}

// ── Thread actions (Ignore button) ───────────────────────────────────────────

/** Mark a thread ignored (or re-mark: refreshes actioned_at). */
export async function upsertThreadAction(
  messageTs: string,
  channelId: string,
  action: string,
  actorUserId: string,
): Promise<void> {
  await getDb()
    .insert(threadActions)
    .values({ messageTs, channelId, action, actorUserId })
    .onConflictDoUpdate({
      target: threadActions.messageTs,
      set: { action, actorUserId, actionedAt: new Date(), channelId },
    });
}

/**
 * actioned_at per thread for the given ts list — the handled rule compares
 * it against the thread's last reply ts.
 */
export async function getThreadActions(
  messageTss: string[],
): Promise<Map<string, Date>> {
  if (messageTss.length === 0) return new Map();
  const rows = await getDb()
    .select({ messageTs: threadActions.messageTs, actionedAt: threadActions.actionedAt })
    .from(threadActions)
    .where(inArray(threadActions.messageTs, messageTss));
  return new Map(rows.map((r) => [r.messageTs, r.actionedAt]));
}

// ── Digest messages (reconciliation) ─────────────────────────────────────────

export interface DigestMessageRow {
  digest_ts: string;
  channel_id: string;
  message_ts: string;
  source_channel_id: string;
  permalink: string;
  text_excerpt: string;
  author_label: string;
  image_url: string | null;
}

export async function recordDigestMessages(
  rows: Array<{
    digestTs: string;
    channelId: string;
    messageTs: string;
    sourceChannelId: string;
    permalink: string;
    textExcerpt: string;
    authorLabel: string;
    imageUrl: string | null;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  await getDb()
    .insert(digestMessages)
    .values(rows)
    .onConflictDoNothing({ target: [digestMessages.digestTs, digestMessages.messageTs] });
}

/** All tracked digest rows: which digest message links to which thread. */
export async function listDigestMessages(): Promise<DigestMessageRow[]> {
  const rows = await getDb().select().from(digestMessages);
  return rows.map((r) => ({
    digest_ts: r.digestTs,
    channel_id: r.channelId,
    message_ts: r.messageTs,
    source_channel_id: r.sourceChannelId,
    permalink: r.permalink,
    text_excerpt: r.textExcerpt,
    author_label: r.authorLabel,
    image_url: r.imageUrl,
  }));
}

export async function deleteDigestMessagesForThreads(
  messageTss: string[],
): Promise<void> {
  if (messageTss.length === 0) return;
  await getDb()
    .delete(digestMessages)
    .where(inArray(digestMessages.messageTs, messageTss));
}
