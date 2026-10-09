import { NextResponse } from "next/server";
import { requireReopsTeamMember } from "../../../../lib/auth";
import { getSetting, listIgnoreEntries } from "../../../../lib/db";
import { listJoinedChannels } from "../../../../lib/slack";
import { logError } from "../../../../lib/log";

export const runtime = "nodejs";

interface LastScan {
  at: string;
  unsolved: number;
  nagged: number;
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const [enabled, nagFrequencyDays, ignoreList, sourceChannelId, targetChannelId, lastScanRaw] =
    await Promise.all([
      getSetting("enabled"),
      getSetting("nag_frequency_days"),
      listIgnoreEntries(),
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("unanswered_reminder.last_scan"),
    ]);

  // Channel list requires a working Slack token; degrade gracefully so the
  // rest of the admin page still loads if the token isn't configured yet.
  let channels: Awaited<ReturnType<typeof listJoinedChannels>> = [];
  let channelsError: string | null = null;
  try {
    channels = await listJoinedChannels();
  } catch (err) {
    channelsError = err instanceof Error ? err.message : String(err);
    logError({ event: "admin.channels_list_failed", message: channelsError });
  }

  let lastScan: LastScan | null = null;
  if (lastScanRaw) {
    try {
      lastScan = JSON.parse(lastScanRaw) as LastScan;
    } catch {
      lastScan = null;
    }
  }

  return NextResponse.json({
    enabled: (enabled ?? "true") === "true",
    nagFrequencyDays: Number.parseInt(nagFrequencyDays ?? "14", 10),
    ignoreList: ignoreList.map((r) => ({
      id: r.id,
      slackId: r.slack_id,
      kind: r.kind,
      label: r.label,
    })),
    sourceChannelId: sourceChannelId || null,
    targetChannelId: targetChannelId || null,
    channels,
    channelsError,
    lastScan,
  });
}
