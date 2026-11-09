import { getSetting, listIgnoreEmails, listIgnoreGroups, setSetting } from "../../lib/db";
import { expandIgnoreSet, fetchOldUnsolvedMessages, listAssigneeOptions, resolveUserLabels } from "../../lib/slack";
import { getGroupMemberEmails } from "../../lib/auth";
import { getHandledEmojis, HANDLED_EMOJIS_SETTING } from "../../lib/handled-emojis";
import { reminders } from "../../lib/reminders-runtime";
import { log, logDebug, logError } from "../../lib/log";
import { isWithinWorkHours } from "../../lib/work-hours";

/** Scan configuration stays here; reminder state/delivery lifecycle lives in reminders. */
export async function runUnansweredReminder(opts?: { ignoreReNagCooldown?: boolean }): Promise<void> {
  if (!isWithinWorkHours(new Date())) {
    log({ event: "bot.skipped", bot: "unanswered-reminder", reason: "outside_work_hours" });
    return;
  }
  if ((await getSetting("frozen")) === "true") {
    log({ event: "bot.skipped", bot: "unanswered-reminder", reason: "frozen" });
    return;
  }

  const windowRaw = (await getSetting("scan_window_days")) ?? "14";
  const minAgeRaw = (await getSetting("min_age_hours")) ?? "1";
  const reNagRaw = (await getSetting("re_nag_hours")) ?? "168";
  const scanWindowDays = Number.parseInt(windowRaw, 10);
  const minAgeHours = Number.parseInt(minAgeRaw, 10);
  const reNagHours = Number.parseFloat(reNagRaw);
  for (const [key, raw, valid] of [
    ["scan_window_days", windowRaw, Number.isFinite(scanWindowDays) && scanWindowDays >= 1],
    ["min_age_hours", minAgeRaw, Number.isFinite(minAgeHours) && minAgeHours >= 0],
    ["re_nag_hours", reNagRaw, Number.isFinite(reNagHours) && reNagHours >= 0.5],
  ] as const) {
    if (!valid) {
      logError({ event: "bot.bad_setting", key, value: raw });
      return;
    }
  }
  const workHoursAware = (await getSetting("work_hours_aware")) !== "false";
  const handledEmojis = new Set(getHandledEmojis(await getSetting(HANDLED_EMOJIS_SETTING)));
  const sourceChannel = (await getSetting("unanswered_reminder.source_channel_id")) ?? process.env.RESEARCHOPS_CHANNEL_ID;
  const targetChannel = (await getSetting("unanswered_reminder.target_channel_id")) ?? process.env.RESEARCHOPS_INTERN_CHANNEL_ID;
  if (!sourceChannel || !targetChannel) {
    logError({ event: "bot.missing_channel_config", has_source: Boolean(sourceChannel), has_target: Boolean(targetChannel) });
    return;
  }

  const manualEmails = await listIgnoreEmails();
  const groups = await listIgnoreGroups();
  const groupEmails: string[] = [];
  for (const group of groups) {
    try {
      groupEmails.push(...(await getGroupMemberEmails(group.kind, group.id)));
    } catch (err) {
      logError({ event: "bot.group_resolve_failed", group: `${group.kind}:${group.id}`, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const allEmails = [...new Set([...manualEmails, ...groupEmails])];
  const team = await expandIgnoreSet(allEmails);
  logDebug({ event: "bot.ignore_resolved", manual_emails: manualEmails.length, groups: groups.length, total_emails: allEmails.length, resolved_slack_users: team.size });

  const messages = await fetchOldUnsolvedMessages(sourceChannel, scanWindowDays, minAgeHours, workHoursAware, handledEmojis);
  const previewUsers = messages.map((message) => message.latestUser ?? message.user);
  const labels = await resolveUserLabels(previewUsers);
  const roster = await listAssigneeOptions(allEmails);
  const result = await reminders.reconcile({
    sourceChannelId: sourceChannel,
    targetChannelId: targetChannel,
    threads: messages.map((message, index) => ({
      ts: message.ts,
      user: message.user,
      parentSolved: message.parentSolved,
      latestReplies: message.latestReplies,
      item: {
        ts: message.ts,
        permalink: message.permalink,
        text: message.latestUser !== null ? message.latestText ?? "" : message.text,
        authorLabel: labels.get(previewUsers[index]) ?? previewUsers[index],
        imageUrl: message.latestImage,
      },
    })),
    team,
    roster,
    reNagHours,
    force: opts?.ignoreReNagCooldown,
  });
  log({ event: "bot.scan", bot: "unanswered-reminder", unsolved: messages.length, after_thread_check: result.channelOpen, assigned_open: result.assignedOpen, to_nag: result.nagged, scan_window_days: scanWindowDays, re_nag_hours: reNagHours, work_hours_aware: workHoursAware });
  await setSetting("unanswered_reminder.last_scan", JSON.stringify({ at: new Date().toISOString(), unsolved: messages.length, nagged: result.nagged }));
}
