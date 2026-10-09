import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth";
import { runMigrations, wipeDatabase } from "../../../../lib/db";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

/**
 * POST — drops the entire public schema and re-runs migrations, returning
 * the app to a fresh-boot state. Bot state (settings, ignore list, admin
 * groups, nag log) is gone after this; the in-process settings are
 * unaffected until something reads them again.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  try {
    await wipeDatabase();
    log({ event: "admin.db_wiped", by: auth.user.navIdent });
    await runMigrations();
    log({ event: "admin.db_rebuilt", by: auth.user.navIdent });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logError({
      event: "admin.db_wipe_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Wipe failed" },
      { status: 500 },
    );
  }
}
