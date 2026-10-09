import { NextResponse } from "next/server";
import { requireReopsTeamMember } from "../../../../lib/auth";
import { setSetting } from "../../../../lib/db";
import { log } from "../../../../lib/log";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: {
    frozen?: boolean;
    scanWindowDays?: number;
    minAgeHours?: number;
    reNagDays?: number;
    sourceChannelId?: string | null;
    targetChannelId?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (typeof body.frozen === "boolean") {
    await setSetting("frozen", body.frozen ? "true" : "false");
    log({ event: "admin.settings_changed", key: "frozen", value: String(body.frozen), by: auth.user.navIdent });
  }

  if (body.scanWindowDays !== undefined) {
    const days = Math.trunc(body.scanWindowDays);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return NextResponse.json({ error: "scanWindowDays must be 1-90" }, { status: 400 });
    }
    await setSetting("scan_window_days", String(days));
    log({ event: "admin.settings_changed", key: "scan_window_days", value: String(days), by: auth.user.navIdent });
  }

  if (body.minAgeHours !== undefined) {
    const hours = Math.trunc(body.minAgeHours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
      return NextResponse.json({ error: "minAgeHours must be 0-168" }, { status: 400 });
    }
    await setSetting("min_age_hours", String(hours));
    log({ event: "admin.settings_changed", key: "min_age_hours", value: String(hours), by: auth.user.navIdent });
  }

  if (body.reNagDays !== undefined) {
    const days = Math.trunc(body.reNagDays);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return NextResponse.json({ error: "reNagDays must be 1-90" }, { status: 400 });
    }
    await setSetting("re_nag_days", String(days));
    log({ event: "admin.settings_changed", key: "re_nag_days", value: String(days), by: auth.user.navIdent });
  }

  // Channel pickers: null/empty string clears the setting (job skips until set).
  const channelIdPattern = /^[CG][A-Z0-9]+$/;
  if (body.sourceChannelId !== undefined) {
    const v = body.sourceChannelId?.trim() ?? "";
    if (v && !channelIdPattern.test(v)) {
      return NextResponse.json({ error: "Ugyldig kanal-ID" }, { status: 400 });
    }
    await setSetting("unanswered_reminder.source_channel_id", v);
    log({ event: "admin.settings_changed", key: "source_channel_id", value: v, by: auth.user.navIdent });
  }

  if (body.targetChannelId !== undefined) {
    const v = body.targetChannelId?.trim() ?? "";
    if (v && !channelIdPattern.test(v)) {
      return NextResponse.json({ error: "Ugyldig kanal-ID" }, { status: 400 });
    }
    await setSetting("unanswered_reminder.target_channel_id", v);
    log({ event: "admin.settings_changed", key: "target_channel_id", value: v, by: auth.user.navIdent });
  }

  return NextResponse.json({ ok: true });
}
