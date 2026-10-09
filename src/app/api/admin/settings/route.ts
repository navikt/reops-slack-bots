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
    enabled?: boolean;
    nagFrequencyDays?: number;
    sourceChannelId?: string | null;
    targetChannelId?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (typeof body.enabled === "boolean") {
    await setSetting("enabled", body.enabled ? "true" : "false");
    log({ event: "admin.settings_changed", key: "enabled", value: String(body.enabled), by: auth.user.navIdent });
  }

  if (body.nagFrequencyDays !== undefined) {
    const days = Math.trunc(body.nagFrequencyDays);
    if (!Number.isFinite(days) || days < 1 || days > 90) {
      return NextResponse.json(
        { error: "nagFrequencyDays må være et heltall mellom 1 og 90" },
        { status: 400 },
      );
    }
    await setSetting("nag_frequency_days", String(days));
    log({ event: "admin.settings_changed", key: "nag_frequency_days", value: String(days), by: auth.user.navIdent });
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
