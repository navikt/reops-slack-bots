import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { log } from "./log";

let pool: Pool | null = null;

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

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function runMigrations(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(process.cwd(), "src/lib/migrations");
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied = await p.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const appliedSet = new Set(applied.rows.map((r) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), "utf-8");
    log({ event: "migration.apply", file });
    await p.query("BEGIN");
    try {
      await p.query(sql);
      await p.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await p.query("COMMIT");
    } catch (err) {
      await p.query("ROLLBACK");
      throw err;
    }
  }
}

// ── Domain helpers ────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const res = await query<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return res.rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

export interface IgnoreListRow {
  id: number;
  kind: "person";
  label: string | null;
  nav_ident: string | null;
  email: string;
  created_at: Date;
}

export async function listIgnoreEntries(): Promise<IgnoreListRow[]> {
  const res = await query<IgnoreListRow>(
    "SELECT id, kind, label, nav_ident, email, created_at FROM ignore_list ORDER BY created_at ASC",
  );
  return res.rows;
}

export async function addIgnoreEntry(
  email: string,
  label: string | null,
  navIdent: string | null,
): Promise<IgnoreListRow> {
  const res = await query<IgnoreListRow>(
    `INSERT INTO ignore_list (kind, label, nav_ident, email) VALUES ('person', $1, $2, $3)
     RETURNING id, kind, label, nav_ident, email, created_at`,
    [label, navIdent, email],
  );
  return res.rows[0];
}

export async function removeIgnoreEntry(id: number): Promise<boolean> {
  const res = await query("DELETE FROM ignore_list WHERE id = $1", [id]);
  return (res.rowCount ?? 0) > 0;
}

export async function listIgnoreEmails(): Promise<string[]> {
  const res = await query<{ email: string }>("SELECT email FROM ignore_list WHERE kind = 'person'");
  return res.rows.map((r) => r.email);
}

// ── Groups (Team Catalog) ─────────────────────────────────────────────────────

export interface GroupRow {
  id: string;
  kind: "team" | "cluster" | "productarea";
  label: string;
}

export async function listGroups(): Promise<GroupRow[]> {
  const res = await query<GroupRow>("SELECT id, kind, label FROM groups ORDER BY label ASC");
  return res.rows;
}

export async function addGroup(id: string, kind: GroupRow["kind"], label: string): Promise<void> {
  await query(
    "INSERT INTO groups (id, kind, label) VALUES ($1, $2, $3) ON CONFLICT (id, kind) DO NOTHING",
    [id, kind, label],
  );
}

export async function removeGroup(id: string, kind: string): Promise<boolean> {
  const res = await query("DELETE FROM groups WHERE id = $1 AND kind = $2", [id, kind]);
  return (res.rowCount ?? 0) > 0;
}

// ── Admin groups (Team Catalog groups whose members may use /admin) ──────────

export async function listAdminGroups(): Promise<GroupRow[]> {
  const res = await query<GroupRow>("SELECT id, kind, label FROM admin_groups ORDER BY label ASC");
  return res.rows;
}

export async function addAdminGroup(id: string, kind: GroupRow["kind"], label: string): Promise<void> {
  await query(
    "INSERT INTO admin_groups (id, kind, label) VALUES ($1, $2, $3) ON CONFLICT (id, kind) DO NOTHING",
    [id, kind, label],
  );
}

export async function removeAdminGroup(id: string, kind: string): Promise<boolean> {
  const res = await query("DELETE FROM admin_groups WHERE id = $1 AND kind = $2", [id, kind]);
  return (res.rowCount ?? 0) > 0;
}

// ── Admin individuals (nav-ident based) ─────────────────────────────────────

export interface AdminIdentRow {
  nav_ident: string;
  label: string | null;
}

export async function listAdminIdents(): Promise<AdminIdentRow[]> {
  const res = await query<AdminIdentRow>(
    "SELECT nav_ident, label FROM admin_idents ORDER BY label ASC NULLS LAST, nav_ident ASC",
  );
  return res.rows;
}

export async function addAdminIdent(navIdent: string, label: string | null): Promise<void> {
  await query(
    "INSERT INTO admin_idents (nav_ident, label) VALUES ($1, $2) ON CONFLICT (nav_ident) DO NOTHING",
    [navIdent, label],
  );
}

export async function removeAdminIdent(navIdent: string): Promise<boolean> {
  const res = await query("DELETE FROM admin_idents WHERE nav_ident = $1", [navIdent]);
  return (res.rowCount ?? 0) > 0;
}

export async function getRecentlyNaggedTs(
  messageTss: string[],
  cooldownHours: number,
): Promise<Set<string>> {
  if (messageTss.length === 0) return new Set();
  const res = await query<{ message_ts: string }>(
    `SELECT message_ts FROM nag_log
     WHERE message_ts = ANY($1::text[])
       AND last_nagged_at > now() - ($2 || ' hours')::interval`,
    [messageTss, String(cooldownHours)],
  );
  return new Set(res.rows.map((r) => r.message_ts));
}

export async function upsertNagLog(messageTs: string, channelId: string): Promise<void> {
  await query(
    `INSERT INTO nag_log (message_ts, channel_id, last_nagged_at) VALUES ($1, $2, now())
     ON CONFLICT (message_ts) DO UPDATE SET last_nagged_at = now(), channel_id = EXCLUDED.channel_id`,
    [messageTs, channelId],
  );
}

/**
 * Drops the entire public schema (all tables incl. schema_migrations) and
 * recreates it empty. Boot-time migrations rebuild everything on next run —
 * call runMigrations() right after, or restart the app.
 */
export async function wipeDatabase(): Promise<void> {
  await query("DROP SCHEMA public CASCADE");
  await query("CREATE SCHEMA public");
  await query("GRANT ALL ON SCHEMA public TO public");
}
