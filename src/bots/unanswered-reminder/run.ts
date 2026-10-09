import {
  getRecentlyNaggedTs,
  getSetting,
  listGroups,
  listIgnoreEmails,
  setSetting,
  upsertNagLog,
} from "../../lib/db";
import {
  expandIgnoreSet,
  fetchOldUnsolvedMessages,
  isThreadHandled,
  postUnansweredDigest,
} from "../../lib/slack";
import { getGroupMemberEmails } from "../../lib/auth";
import { log, logDebug, logError } from "../../lib/log";

const DEFAULT_SCAN_WINDOW_DAYS = 14;
/** Messages younger than this get a grace period before the bot cares. */
const DEFAULT_MIN_MESSAGE_AGE_HOURS = 1;
/** Cooldown before a nagged message is eligible for another digest. */
const DEFAULT_RE_NAG_DAYS = 7;

export async function runUnansweredReminder(): Promise<void> {
  const frozen = (await getSetting("frozen")) ?? "false";
  if (frozen === "true") {
    log({ event: "bot.skipped", bot: "unanswered-reminder", reason: "frozen" });
    return;
  }

  const windowRaw = (await getSetting("scan_window_days")) ?? String(DEFAULT_SCAN_WINDOW_DAYS);
  const scanWindowDays = Number.parseInt(windowRaw, 10);
  if (Number.isNaN(scanWindowDays) || scanWindowDays < 1) {
    logError({ event: "bot.bad_setting", key: "scan_window_days", value: windowRaw });
    return;
  }

  const minAgeRaw = (await getSetting("min_age_hours")) ?? String(DEFAULT_MIN_MESSAGE_AGE_HOURS);
  const minAgeHours = Number.parseInt(minAgeRaw, 10);
  if (Number.isNaN(minAgeHours) || minAgeHours < 0) {
    logError({ event: "bot.bad_setting", key: "min_age_hours", value: minAgeRaw });
    return;
  }

  const reNagRaw = (await getSetting("re_nag_days")) ?? String(DEFAULT_RE_NAG_DAYS);
  const reNagDays = Number.parseInt(reNagRaw, 10);
  if (Number.isNaN(reNagDays) || reNagDays < 1) {
    logError({ event: "bot.bad_setting", key: "re_nag_days", value: reNagRaw });
    return;
  }

  const sourceChannel =
    (await getSetting("unanswered_reminder.source_channel_id")) ??
    process.env.RESEARCHOPS_CHANNEL_ID;
  const targetChannel =
    (await getSetting("unanswered_reminder.target_channel_id")) ??
    process.env.RESEARCHOPS_INTERN_CHANNEL_ID;
  if (!sourceChannel || !targetChannel) {
    logError({
      event: "bot.missing_channel_config",
      has_source: Boolean(sourceChannel),
      has_target: Boolean(targetChannel),
    });
    return;
  }

  // Ignore set = manual people (by email) + members of configured Team
  // Catalog groups (team/cluster/seksjon, recursing into child teams).
  // Emails resolve to Slack UIDs via users.lookupByEmail.
  const manualEmails = await listIgnoreEmails();
  const groups = await listGroups();
  const groupEmails: string[] = [];
  for (const g of groups) {
    try {
      groupEmails.push(...(await getGroupMemberEmails(g.kind, g.id)));
    } catch (err) {
      logError({
        event: "bot.group_resolve_failed",
        group: `${g.kind}:${g.id}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const allEmails = [...new Set([...manualEmails, ...groupEmails])];
  const ignoreSet = await expandIgnoreSet(allEmails);
  logDebug({
    event: "bot.ignore_resolved",
    manual_emails: manualEmails.length,
    groups: groups.length,
    total_emails: allEmails.length,
    resolved_slack_users: ignoreSet.size,
  });
  const unsolved = await fetchOldUnsolvedMessages(
    sourceChannel,
    scanWindowDays,
    minAgeHours,
  );

  const candidates = unsolved.filter((m) => !ignoreSet.has(m.user));

  logDebug({
    event: "bot.scan_window",
    source: sourceChannel,
    older_than_days: scanWindowDays,
    grace_hours: minAgeHours,
    ignore_count: ignoreSet.size,
    window_results: unsolved.length,
  });
  for (const m of unsolved) {
    if (ignoreSet.has(m.user)) {
      logDebug({ event: "bot.decision", ts: m.ts, verdict: "skip", why: "author on ignore list (team)", author: m.user });
    }
  }

  // Skip threads already handled: last reply from a team member, or :solved:
  // anywhere in the thread. Threads without replies are never handled.
  //
  // conversations.history embeds the newest replies (latest_replies), so when
  // the last reply author is present AND not on the ignore list, the thread
  // is nag-worthy regardless — no conversations.replies call needed. We only
  // fetch the thread when the last reply came from a team member, to check
  // whether some other reply carries :solved:.
  const handled = new Set<string>();
  for (const m of candidates) {
    if (m.replyCount === 0) {
      logDebug({ event: "bot.decision", ts: m.ts, verdict: "candidate", why: "no thread replies" });
      continue;
    }
    const lastReplyUser = m.latestReplyUsers[m.latestReplyUsers.length - 1];
    if (lastReplyUser && !ignoreSet.has(lastReplyUser)) {
      logDebug({
        event: "bot.decision",
        ts: m.ts,
        verdict: "candidate",
        why: "last reply by non-team user",
        last_reply_user: lastReplyUser,
      });
      continue;
    }
    if (await isThreadHandled(sourceChannel, m.ts, ignoreSet)) {
      logDebug({
        event: "bot.decision",
        ts: m.ts,
        verdict: "skip",
        why: "thread handled (team reply last, or :solved: in thread)",
        last_reply_user: lastReplyUser ?? null,
      });
      handled.add(m.ts);
    }
  }
  const open = candidates.filter((m) => !handled.has(m.ts));

  const recentlyNagged = await getRecentlyNaggedTs(
    open.map((m) => m.ts),
    reNagDays,
  );

  const toNag = open.filter((m) => !recentlyNagged.has(m.ts));

  for (const m of open) {
    if (recentlyNagged.has(m.ts)) {
      logDebug({ event: "bot.decision", ts: m.ts, verdict: "skip", why: "already nagged within window" });
    } else {
      logDebug({ event: "bot.decision", ts: m.ts, verdict: "nag", author: m.user, text_preview: m.text.slice(0, 80) });
    }
  }

  log({
    event: "bot.scan",
    bot: "unanswered-reminder",
    unsolved: unsolved.length,
    after_ignore: candidates.length,
    after_thread_check: open.length,
    to_nag: toNag.length,
    scan_window_days: scanWindowDays,
    re_nag_days: reNagDays,
  });

  await setSetting(
    "unanswered_reminder.last_scan",
    JSON.stringify({
      at: new Date().toISOString(),
      unsolved: unsolved.length,
      nagged: toNag.length,
    }),
  );

  if (toNag.length > 0) {
    try {
      await postUnansweredDigest(
        targetChannel,
        toNag.map((m) => ({ ts: m.ts, permalink: m.permalink })),
      );
      for (const m of toNag) {
        await upsertNagLog(m.ts, sourceChannel);
      }
    } catch (err) {
      logError({
        event: "bot.nag_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
