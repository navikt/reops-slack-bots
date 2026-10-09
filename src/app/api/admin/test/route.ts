import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth";
import { getSetting } from "../../../../lib/db";
import { postUnansweredDigest } from "../../../../lib/slack";
import { runJob } from "../../../../lib/runner";
import { log } from "../../../../lib/log";

export const runtime = "nodejs";

/**
 * Test tools for the unanswered-reminder behavior.
 *  - action=scan:  runs the real hourly job immediately (respects frozen,
 *    writes to nag_log, posts real reminders if candidates exist).
 *  - action=ping:  posts a clearly-marked fake reminder to the configured
 *    target channel. Wiring check only — no nag_log write, no scan.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: { action?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (body.action === "scan") {
    if ((await getSetting("frozen")) === "true") {
      return NextResponse.json({ error: "Bot is frozen" }, { status: 409 });
    }
    log({ event: "admin.test_scan", by: auth.user.navIdent });
    const { runUnansweredReminder } = await import(
      "../../../../bots/unanswered-reminder/run"
    );
    await runJob({ name: "unanswered-reminder-manual", intervalMs: 0, run: runUnansweredReminder });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "ping") {
    const target =
      (await getSetting("unanswered_reminder.target_channel_id")) ??
      process.env.RESEARCHOPS_INTERN_CHANNEL_ID;
    if (!target) {
      return NextResponse.json({ error: "No reminder channel configured" }, { status: 409 });
    }
    log({ event: "admin.test_ping", channel: target, by: auth.user.navIdent });
    await postUnansweredDigest(target, [
      {
        ts: String(Date.now() / 1000),
        permalink: "https://github.com/navikt/reops-slack-bots",
      },
    ]);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
