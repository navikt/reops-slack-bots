import { NextResponse } from "next/server";
import { getGroupMemberEmails, requireAdmin } from "../../../../lib/auth";
import { getSetting, listAdminGroups, listAdminIdents, listGroups, listIgnoreEntries } from "../../../../lib/db";
import { listJoinedChannels } from "../../../../lib/slack";
import { logError } from "../../../../lib/log";

export const runtime = "nodejs";

interface LastScan {
  at: string;
  unsolved: number;
  nagged: number;
}

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const [frozen, scanWindowDays, minAgeHours, reNagHours, ignoreList, sourceChannelId, targetChannelId, lastScanRaw, adminGroups, adminIdents] =
    await Promise.all([
      getSetting("frozen"),
      getSetting("scan_window_days"),
      getSetting("min_age_hours"),
      getSetting("re_nag_hours"),
      listIgnoreEntries(),
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("unanswered_reminder.last_scan"),
      listAdminGroups(),
      listAdminIdents(),
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
  // Applies to both ignore-groups and admin-groups.
  const withCounts = async (gs: Array<{ id: string; kind: "team" | "cluster" | "productarea"; label: string }>) =>
    Promise.all(
      gs.map(async (g) => {
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

  const groups = await listGroups();
  const [groupsWithCounts, adminGroupsWithCounts] = await Promise.all([
    withCounts(groups),
    withCounts(adminGroups),
  ]);

  return NextResponse.json({
    frozen: isFrozen,
    scanWindowDays: Number.parseInt(scanWindowDays ?? "14", 10),
    minAgeHours: Number.parseInt(minAgeHours ?? "1", 10),
    reNagHours: Number.parseFloat(reNagHours ?? String(7 * 24)),
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
    adminGroups: adminGroupsWithCounts,
    adminIdents,
    adminBootstrap: adminGroups.length === 0 && adminIdents.length === 0,
  });
}
