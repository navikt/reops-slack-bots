import { NextResponse } from "next/server";
import { getGroupMemberEmails, requireReopsTeamMember } from "../../../../lib/auth";
import { getSetting, listGroups, listIgnoreEntries } from "../../../../lib/db";
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

  const [frozen, scanWindowDays, minAgeHours, reNagDays, ignoreList, sourceChannelId, targetChannelId, lastScanRaw] =
    await Promise.all([
      getSetting("frozen"),
      getSetting("scan_window_days"),
      getSetting("min_age_hours"),
      getSetting("re_nag_days"),
      listIgnoreEntries(),
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("unanswered_reminder.last_scan"),
    ]);

  // Channel list requires a working Slack token; degrade gracefully so the
  // rest of the admin page still loads if the token isn't configured yet
  // or the bot is frozen.
  let channels: Awaited<ReturnType<typeof listJoinedChannels>> = [];
  let channelsError: string | null = null;
  const isFrozen = (frozen ?? "false") === "true";
  if (!isFrozen) {
    try {
      channels = await listJoinedChannels();
    } catch (err) {
      channelsError = err instanceof Error ? err.message : String(err);
      logError({ event: "admin.channels_list_failed", message: channelsError });
    }
  }

  let lastScan: LastScan | null = null;
  if (lastScanRaw) {
    try {
      lastScan = JSON.parse(lastScanRaw) as LastScan;
    } catch {
      lastScan = null;
    }
  }

  // Configured Team Catalog groups with live member counts (best effort).
  const groups = await listGroups();
  const groupsWithCounts = await Promise.all(
    groups.map(async (g) => {
      try {
        const emails = await getGroupMemberEmails(g.kind, g.id);
        return { ...g, memberCount: emails.length, error: null };
      } catch (err) {
        return {
          ...g,
          memberCount: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return NextResponse.json({
    frozen: isFrozen,
    scanWindowDays: Number.parseInt(scanWindowDays ?? "14", 10),
    minAgeHours: Number.parseInt(minAgeHours ?? "1", 10),
    reNagDays: Number.parseInt(reNagDays ?? "7", 10),
    ignoreList: ignoreList.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      navIdent: r.nav_ident,
      email: r.email,
    })),
    sourceChannelId: sourceChannelId || null,
    targetChannelId: targetChannelId || null,
    channels,
    channelsError,
    lastScan,
    groups: groupsWithCounts,
  });
}
