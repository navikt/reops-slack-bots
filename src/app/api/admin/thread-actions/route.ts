import { NextResponse } from "next/server";
import { getGroupMemberEmails, requireAdmin } from "../../../../lib/auth";
import {
  getSetting,
  getThreadActions,
  listIgnoreEmails,
  listIgnoreGroups,
} from "../../../../lib/db";
import { diagnosticThreadSources } from "../../../../lib/admin-diagnostics-store";
import {
  inferThreadSource,
  parseAdminThreadCommand,
  slackTimestampIso,
  type ThreadInspection,
} from "../../../../lib/admin-diagnostics";
import {
  getHandledEmojis,
  HANDLED_EMOJIS_SETTING,
} from "../../../../lib/handled-emojis";
import {
  inspectReminderThread,
  listAssigneeOptions,
  resolveEmailsToUserIds,
} from "../../../../lib/slack";
import { ReminderConflictError, routeThread } from "../../../../lib/reminders";
import { reminders } from "../../../../lib/reminders-runtime";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

function problem(status: number, title: string, detail = title): Response {
  return NextResponse.json(
    { type: "about:blank", title, detail, status },
    { status, headers: { "Content-Type": "application/problem+json" } },
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok")
    return problem(
      auth.status === "forbidden"
        ? 403
        : auth.status === "unavailable"
          ? 503
          : 401,
      auth.status,
    );
  if (
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  )
    return problem(415, "JSON content type required");
  let command;
  try {
    command = parseAdminThreadCommand(await req.json());
  } catch (err) {
    return problem(
      400,
      "Invalid request",
      err instanceof Error ? err.message : "Invalid request",
    );
  }
  try {
    if ((await getSetting("frozen")) === "true")
      return problem(
        409,
        "Bot is off",
        "Turn it on to check or update Slack threads.",
      );
    const configured =
      (await getSetting("unanswered_reminder.source_channel_id")) ??
      process.env.RESEARCHOPS_CHANNEL_ID ??
      null;
    const source = inferThreadSource(
      await diagnosticThreadSources(command.threadTs),
      configured,
    );
    if (source.source !== command.sourceChannelId)
      return problem(
        409,
        "Thread source unavailable",
        "Thread source is unknown or changed. Refresh diagnostics.",
      );
    const groups = await listIgnoreGroups();
    // A partial roster is unsafe for live status and assignment authorization.
    const groupEmails = (
      await Promise.all(
        groups.map((group) => getGroupMemberEmails(group.kind, group.id)),
      )
    ).flat();
    const emails = [
      ...new Set([...(await listIgnoreEmails()), ...groupEmails]),
    ];
    const roster = await listAssigneeOptions(emails, true);
    if (command.action === "inspect") {
      const emojis = new Set(
        getHandledEmojis(await getSetting(HANDLED_EMOJIS_SETTING)),
      );
      const thread = await inspectReminderThread(
        command.sourceChannelId,
        command.threadTs,
        emojis,
      );
      const action = (await getThreadActions([command.threadTs])).get(
        command.threadTs,
      );
      const route = routeThread(
        thread,
        new Set(roster.map((entry) => entry.userId)),
        action,
      );
      const latestTs = String(thread.latestReplies.at(-1)?.ts ?? thread.ts);
      const result: ThreadInspection = {
        status: route.kind,
        checkedAt: new Date().toISOString(),
        latestActivityAt:
          slackTimestampIso(
            latestTs.includes(".") ? latestTs : `${latestTs}.0`,
          ) ?? new Date(Number(latestTs) * 1000).toISOString(),
        permalink: thread.item.permalink,
        preview: thread.item.text,
      };
      return NextResponse.json(result);
    }
    if (
      command.action === "assigned" &&
      !roster.some((entry) => entry.userId === command.assignee)
    )
      return problem(
        400,
        "Invalid assignee",
        "Assignee must be in the configured team.",
      );
    const actor = auth.user.email
      ? [...(await resolveEmailsToUserIds([auth.user.email]))][0]
      : undefined;
    await reminders.act({
      sourceChannelId: command.sourceChannelId,
      threadTs: command.threadTs,
      action: command.action,
      actor: actor ?? `nav:${auth.user.navIdent}`,
      assignee: command.assignee,
      expectedActionedAt: command.expectedActionedAt,
      roster,
      // Admin commands have no clicked Slack message. The manager updates all
      // tracked copies; no legacy payload fallback is applicable.
      clicked: {
        channelId: command.sourceChannelId,
        deliveryTs: "",
        blocks: [],
      },
    });
    log({
      event: "admin.thread_action",
      action: command.action,
      thread_ts: command.threadTs,
      by: auth.user.navIdent,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ReminderConflictError)
      return problem(409, "Thread changed", err.message);
    logError({
      event: "admin.thread_action_failed",
      thread_ts: command.threadTs,
      message: err instanceof Error ? err.message : String(err),
    });
    return problem(
      502,
      "Thread update unavailable",
      "Could not check or update the thread. Slack or Team Catalog may be unavailable.",
    );
  }
}
