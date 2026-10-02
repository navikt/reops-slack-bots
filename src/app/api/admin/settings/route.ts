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

  let body: { enabled?: boolean; nagFrequencyDays?: number };
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

  return NextResponse.json({ ok: true });
}
