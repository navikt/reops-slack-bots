import { NextResponse } from "next/server";
import { migrationsAppliedInDb } from "../../../../lib/migrate";
import { logError } from "../../../../lib/log";

/**
 * Ready only once boot migrations have completed — before that, every
 * request would fail with "relation does not exist" anyway.
 *
 * Queries the DB directly (drizzle.__drizzle_migrations vs the journal in
 * drizzle/meta/_journal.json) rather than trusting an in-process flag:
 * Next's standalone/Turbopack build can bundle this route handler and the
 * instrumentation hook into separate chunks, each with its own copy of
 * module scope — an in-memory "migrations done" bit set by the
 * instrumentation bundle's runMigrations() is not guaranteed visible here.
 * Fails closed: a DB error is reported as not-ready, not ready.
 */
export async function GET(): Promise<Response> {
  try {
    if (!(await migrationsAppliedInDb())) {
      return NextResponse.json({ status: "migrating" }, { status: 503 });
    }
    return NextResponse.json({ status: "ready" });
  } catch (err) {
    logError({
      event: "isready.check_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
