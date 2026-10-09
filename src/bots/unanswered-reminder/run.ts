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
/** Cooldown in hours before a nagged message is eligible for another digest. */
const DEFAULT_RE_NAG_HOURS = 7 * 24;

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

  const reNagRaw = (await getSetting("re_nag_hours")) ?? String(DEFAULT_RE_NAG_HOURS);
  const reNagHours = Number.parseFloat(reNagRaw);
  if (Number.isNaN(reNagHours) || reNagHours < 0.5) {
    logError({ event: "bot.bad_setting", key: "re_nag_hours", value: reNagRaw });
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

  // Handled rule (see isThreadHandled): :solved: and team replies are
  // equal-rank signals, recency decides — re-openable conversations. Runs on
  // data embedded in conversations.history, so no extra Slack calls.
  const open: typeof candidates = [];
  for (const m of candidates) {
    const lastReplyUser = m.latestReplies[m.latestReplies.length - 1]?.user ?? null;
    if (isThreadHandled(m, ignoreSet)) {
      logDebug({
        event: "bot.decision",
        ts: m.ts,
        verdict: "skip",
        why: "handled (team reply last, or :solved: newer than last non-team activity)",
        last_reply_user: lastReplyUser,
      });
      continue;
    }
    logDebug({
      event: "bot.decision",
      ts: m.ts,
      verdict: "candidate",
      why:
        m.replyCount === 0
          ? "no thread replies"
          : lastReplyUser
            ? "last activity by non-team user, no newer :solved:"
            : "last reply author unknown",
      last_reply_user: lastReplyUser,
    });
    open.push(m);
  }

  const recentlyNagged = await getRecentlyNaggedTs(
    open.map((m) => m.ts),
    reNagHours,
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
    re_nag_hours: reNagHours,
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
