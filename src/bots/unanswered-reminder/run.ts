import {
  deleteDigestMessagesForThreads,
  getRecentlyNaggedTs,
  getSetting,
  getThreadActions,
  listDigestMessages,
  listIgnoreGroups,
  listIgnoreEmails,
  recordDigestMessages,
  setSetting,
  upsertNagLog,
} from "../../lib/db";
import {
  deleteDigestMessage,
  expandIgnoreSet,
  fetchOldUnsolvedMessages,
  isThreadHandled,
  postUnansweredDigest,
  resolveUserLabels,
  updateUnansweredDigest,
} from "../../lib/slack";
import { getGroupMemberEmails } from "../../lib/auth";
import { log, logDebug, logError } from "../../lib/log";

const DEFAULT_SCAN_WINDOW_DAYS = 14;
/** Messages younger than this get a grace period before the bot cares. */
const DEFAULT_MIN_MESSAGE_AGE_HOURS = 1;
/** Cooldown in hours before a nagged message is eligible for another digest. */
const DEFAULT_RE_NAG_HOURS = 7 * 24;

export async function runUnansweredReminder(opts?: { ignoreReNagCooldown?: boolean }): Promise<void> {
  const ignoreReNagCooldown = opts?.ignoreReNagCooldown ?? false;
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

  // Smart work-hours awareness (advanced setting): when enabled (default),
  // grace for messages posted outside 09:00-16:30 Mon-Fri jumps to the next
  // workday opening before counting min_age_hours. Disable to test/debug
  // outside work hours, where that jump would otherwise hide messages for
  // up to a full day regardless of min_age_hours.
  const workHoursAwareRaw = (await getSetting("work_hours_aware")) ?? "true";
  const workHoursAware = workHoursAwareRaw !== "false";

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
  const groups = await listIgnoreGroups();
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
    workHoursAware,
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

  // Handled rule (see isThreadHandled): team reply last, manual Suppress,
  // or :solved: recency — re-openable conversations. Suppress marks come
  // from thread_actions (digest Suppress button), compared vs last reply ts.
  const actionsByTs = await getThreadActions(candidates.map((m) => m.ts));

  const open: typeof candidates = [];
  const handledTs: string[] = [];
  for (const m of candidates) {
    const lastReplyUser = m.latestReplies[m.latestReplies.length - 1]?.user ?? null;
    const ignoredAt = actionsByTs.get(m.ts);
    const handled = isThreadHandled(
      { ...m, ignoredAt: ignoredAt ? ignoredAt.getTime() / 1000 : null },
      ignoreSet,
    );
    if (handled) {
      handledTs.push(m.ts);
      logDebug({
        event: "bot.decision",
        ts: m.ts,
        verdict: "skip",
        why: ignoredAt
          ? "handled (ignored via digest button)"
          : "handled (team reply last, or :solved: newer than last non-team activity)",
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

  const recentlyNagged = ignoreReNagCooldown
    ? new Set<string>()
    : await getRecentlyNaggedTs(
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
    work_hours_aware: workHoursAware,
    ...(ignoreReNagCooldown ? { forced: true } : {}),
  });

  await setSetting(
    "unanswered_reminder.last_scan",
    JSON.stringify({
      at: new Date().toISOString(),
      unsolved: unsolved.length,
      nagged: toNag.length,
    }),
  );

  // Digest lifecycle: ONE living digest per target channel. When anything is
  // due to (re-)nag, all previously tracked digests are deleted and a single
  // fresh digest with the FULL open set is posted — the channel always shows
  // one current message at the bottom. Scans with nothing new to nag only
  // shrink existing digests in place (handled threads drop off).
  const trackedBefore = await listDigestMessages();

  if (toNag.length > 0) {
    try {
      for (const row of new Map(trackedBefore.map((r) => [r.digest_ts, r])).values()) {
        await deleteDigestMessage(row.channel_id, row.digest_ts);
      }
      await deleteDigestMessagesForThreads(trackedBefore.map((r) => r.message_ts));

      // Preview mirrors the link target: latest reply (author + text +
      // image) when the thread has replies, the parent message otherwise.
      const previewUsers = open.map((m) => m.latestUser ?? m.user);
      const labels = await resolveUserLabels(previewUsers);
      const items = open.map((m, i) => {
        const hasReply = m.latestUser !== null;
        const authorId = previewUsers[i];
        return {
          ts: m.ts,
          permalink: m.permalink,
          text: hasReply ? (m.latestText ?? "") : m.text,
          authorLabel:
            (authorId ? labels.get(authorId) : undefined) ??
            authorId ??
            m.user,
          imageUrl: m.latestImage,
        };
      });
      const posted = await postUnansweredDigest(targetChannel, items);
      await recordDigestMessages(
        posted.flatMap((p) =>
          p.items.map((item) => ({
            digestTs: p.digestTs,
            channelId: targetChannel,
            messageTs: item.ts,
            sourceChannelId: sourceChannel,
            permalink: item.permalink,
            textExcerpt: item.text.slice(0, 500),
            authorLabel: item.authorLabel,
            imageUrl: item.imageUrl,
          })),
        ),
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
  } else {
    // Nothing new to nag: reconcile in place — drop handled/suppressed
    // threads from tracked digests, delete empties.
    try {
      const tracked = trackedBefore;
      if (tracked.length > 0) {
        const openTs = new Set(open.map((m) => m.ts));
        const byDigest = new Map<
          string,
          { channelId: string; rows: typeof tracked }
        >();
        for (const row of tracked) {
          const entry = byDigest.get(row.digest_ts) ?? {
            channelId: row.channel_id,
            rows: [],
          };
          entry.rows.push(row);
          byDigest.set(row.digest_ts, entry);
        }
        const stale: string[] = [];
        for (const [digestTs, info] of byDigest) {
          const remainingRows = info.rows.filter((r) => openTs.has(r.message_ts));
          await updateUnansweredDigest(
            info.channelId,
            digestTs,
            remainingRows.map((r) => {
              const live = open.find((m) => m.ts === r.message_ts);
              return {
                ts: r.message_ts,
                // Live permalink from the current scan (points at latest
                // activity); fall back to the as-posted one.
                permalink: live?.permalink ?? r.permalink,
                text: live?.text ?? r.text_excerpt,
                authorLabel: r.author_label,
                imageUrl: r.image_url,
              };
            }),
            open.length,
          );
          stale.push(
            ...info.rows
              .filter((r) => !openTs.has(r.message_ts))
              .map((r) => r.message_ts),
          );
        }
        await deleteDigestMessagesForThreads(stale);
      }
    } catch (err) {
      logError({
        event: "bot.digest_reconcile_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
