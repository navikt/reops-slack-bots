import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth";
import { getSetting } from "../../../../lib/db";
import { dmAssignment, postUnansweredDigest } from "../../../../lib/slack";
import { runJob } from "../../../../lib/runner";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

/**
 * Test tools for the unanswered-reminder behavior.
 *  - action=scan_force:  runs the real hourly job immediately, ignoring the
 *                        re-nag cooldown — messages already reminded about are
 *                        included. Respects frozen (409); nag_log is written
 *                        and real reminders are posted.
 *  - action=ping:        posts a clearly-marked fake reminder to the configured
 *                        target channel. Wiring check only — no nag_log write,
 *                        no scan.
 *  - action=dm:          sends the caller a fake "assigned" DM. Verifies the
 *                        im:write scope + conversations.open + dmAssignment
 *                        rendering path without needing a real assignment.
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

  if (body.action === "scan_force") {
    if ((await getSetting("frozen")) === "true") {
      return NextResponse.json({ error: "Bot is frozen" }, { status: 409 });
    }
    log({ event: "admin.test_scan_force", by: auth.user.navIdent });
    const { runUnansweredReminder } = await import(
      "../../../../bots/unanswered-reminder/run"
    );
    await runJob({
      name: "unanswered-reminder-manual-forced",
      intervalMs: 0,
      run: () => runUnansweredReminder({ ignoreReNagCooldown: true }),
    });
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
        text: "Test digest — wiring check from /admin. Not a real unanswered message.",
        authorLabel: "reops-bots",
        imageUrl: null,
      },
    ]);
    return NextResponse.json({ ok: true });
  }

  if (body.action === "dm") {
    // The caller DMs themselves — no point picking a target, this is a wiring
    // check for the caller's own Slack app + scopes. Caller must have a
    // resolved Slack UID (state.you.slackUserId) or we can't open the DM.
    if (!auth.user.email) {
      return NextResponse.json(
        { error: "No email on your token — can't resolve Slack UID" },
        { status: 409 },
      );
    }
    const { resolveEmailsToUserIds } = await import("../../../../lib/slack");
    const uids = await resolveEmailsToUserIds([auth.user.email]);
    const slackUserId = [...uids][0];
    if (!slackUserId) {
      return NextResponse.json(
        { error: `No Slack user found for ${auth.user.email}` },
        { status: 404 },
      );
    }
    log({ event: "admin.test_dm", by: auth.user.navIdent, slack_user: slackUserId });
    try {
      const dmChannel = await dmAssignment(
        slackUserId,
        {
          ts: String(Date.now() / 1000),
          permalink: "https://github.com/navikt/reops-slack-bots",
          text: "Test assignment DM — wiring check from /admin. Not a real thread.",
          authorLabel: "reops-bots",
          imageUrl: null,
        },
        [], // no roster — "Assign to…" select renders with only "release"
        "reops-bot",
      );
      if (!dmChannel) {
        return NextResponse.json(
          { error: "conversations.open failed — is im:write scope granted?" },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, dmChannel });
    } catch (err) {
      logError({
        event: "admin.test_dm_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "DM failed" },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
