import { NextResponse } from "next/server";
import { getGroupMemberEmails, requireAdmin } from "../../../../lib/auth";
import {
  getNagLogCount,
  getSetting,
  getTableCounts,
  listAdminGroups,
  listAdminPersons,
  listIgnoreGroups,
  listIgnorePersons,
  listNagSuppressed,
  listRecentNagLog,
  listThreadActions,
} from "../../../../lib/db";
import { listJoinedChannels, resolveEmailsToUserIds } from "../../../../lib/slack";
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

  const reNagHoursRaw = await getSetting("re_nag_hours");
  const reNagHoursNum = Number.parseFloat(reNagHoursRaw ?? String(7 * 24));

  const [frozen, scanWindowDays, minAgeHours, workHoursAware, ignorePersons, sourceChannelId, targetChannelId, lastScanRaw, adminGroups, adminPersons, nagLogCount, nagLogRecentRaw, tableCounts, nagSuppressedRaw, threadActionsRaw] =
    await Promise.all([
      getSetting("frozen"),
      getSetting("scan_window_days"),
      getSetting("min_age_hours"),
      getSetting("work_hours_aware"),
      listIgnorePersons(),
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("unanswered_reminder.last_scan"),
      listAdminGroups(),
      listAdminPersons(),
      getNagLogCount(),
      listRecentNagLog(10),
      getTableCounts(),
      listNagSuppressed(Number.isNaN(reNagHoursNum) ? 7 * 24 : reNagHoursNum),
      listThreadActions(),
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

  const groups = await listIgnoreGroups();
  const [groupsWithCounts, adminGroupsWithCounts] = await Promise.all([
    withCounts(groups),
    withCounts(adminGroups),
  ]);

  // "You" card: resolve the caller's navIdent -> email -> Slack UID, and
  // whether that UID currently lands in the ignore set. Makes "why did the
  // bot treat my reply as non-team?" answerable from the UI.
  let you: {
    navIdent: string;
    email: string | null;
    slackUserId: string | null;
    ignored: boolean;
  } | null = null;
  try {
    const groupEmailLists = await Promise.all(
      groups.map(async (g) => {
        try {
          return await getGroupMemberEmails(g.kind, g.id);
        } catch {
          return [] as string[];
        }
      }),
    );
    const ignoreEmails = [
      ...new Set([
        ...ignorePersons.map((p) => p.email),
        ...groupEmailLists.flat(),
      ]),
    ];
    const email = auth.user.email ?? null;
    let slackUserId: string | null = null;
    if (email && !isFrozen) {
      const ids = await resolveEmailsToUserIds([email]);
      slackUserId = [...ids][0] ?? null;
    }
    let ignored = false;
    if (slackUserId) {
      const ignoreSet = await resolveEmailsToUserIds(ignoreEmails);
      ignored = ignoreSet.has(slackUserId);
    }
    you = { navIdent: auth.user.navIdent, email, slackUserId, ignored };
  } catch (err) {
    logError({
      event: "admin.you_resolve_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return NextResponse.json({
    frozen: isFrozen,
    scanWindowDays: Number.parseInt(scanWindowDays ?? "14", 10),
    minAgeHours: Number.parseInt(minAgeHours ?? "1", 10),
    reNagHours: reNagHoursNum,
    workHoursAware: (workHoursAware ?? "true") !== "false",
    ignorePersons: ignorePersons.map((r) => ({
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
    adminPersons,
    adminBootstrap: adminGroups.length === 0 && adminPersons.length === 0,
    nagLogCount,
    nagLogRecent: nagLogRecentRaw.map((r) => ({
      message_ts: r.message_ts,
      channel_id: r.channel_id,
      last_nagged_at: r.last_nagged_at.toISOString(),
    })),
    nagSuppressed: nagSuppressedRaw.map((r) => ({
      message_ts: r.message_ts,
      channel_id: r.channel_id,
      next_eligible_at: r.next_eligible_at.toISOString(),
    })),
    threadActions: threadActionsRaw.map((r) => ({
      message_ts: r.message_ts,
      channel_id: r.channel_id,
      action: r.action,
      actor_user_id: r.actor_user_id,
      assignee_user_id: r.assignee_user_id,
      actioned_at: r.actioned_at.toISOString(),
    })),
    tableCounts,
    you,
  });
}
