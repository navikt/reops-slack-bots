import { NextResponse } from "next/server";
import { requireReopsTeamMember } from "../../../../lib/auth";
import { getSetting, listIgnoreEntries } from "../../../../lib/db";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const [enabled, nagFrequencyDays, ignoreList] = await Promise.all([
    getSetting("enabled"),
    getSetting("nag_frequency_days"),
    listIgnoreEntries(),
  ]);

  return NextResponse.json({
    enabled: (enabled ?? "true") === "true",
    nagFrequencyDays: Number.parseInt(nagFrequencyDays ?? "7", 10),
    ignoreList: ignoreList.map((r) => ({
      id: r.id,
      slackId: r.slack_id,
      kind: r.kind,
      label: r.label,
    })),
  });
}
