import {
  getPool,
  getRecentlyNaggedTs,
  getSetting,
  setSetting,
  upsertNagLog,
} from "../../lib/db";
import {
  expandIgnoreSet,
  fetchOldUnsolvedMessages,
  isThreadHandled,
  postReminder,
} from "../../lib/slack";
import { log, logError } from "../../lib/log";

const DEFAULT_NAG_FREQUENCY_DAYS = 14;
/** Messages younger than this get a grace period before the bot cares. */
const MIN_MESSAGE_AGE_HOURS = 1;

export async function runUnansweredReminder(): Promise<void> {
  const enabled = (await getSetting("enabled")) ?? "true";
  if (enabled !== "true") {
    log({ event: "bot.skipped", bot: "unanswered-reminder", reason: "disabled" });
    return;
  }

  const frequencyRaw = (await getSetting("nag_frequency_days")) ?? String(DEFAULT_NAG_FREQUENCY_DAYS);
  const frequencyDays = Number.parseInt(frequencyRaw, 10);
  if (Number.isNaN(frequencyDays) || frequencyDays < 1) {
    logError({ event: "bot.bad_setting", key: "nag_frequency_days", value: frequencyRaw });
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

  const pool = getPool();
  const ignoreSet = await expandIgnoreSet(pool);
  const unsolved = await fetchOldUnsolvedMessages(
    sourceChannel,
    frequencyDays,
    MIN_MESSAGE_AGE_HOURS,
  );

  const candidates = unsolved.filter((m) => !ignoreSet.has(m.user));

  // Skip threads already handled: last reply from a team member, or :solved:
  // anywhere in the thread. Threads without replies are never handled.
  const handled = new Set<string>();
  for (const m of candidates) {
    if (m.replyCount === 0) continue;
    if (await isThreadHandled(sourceChannel, m.ts, ignoreSet)) {
      handled.add(m.ts);
    }
  }
  const open = candidates.filter((m) => !handled.has(m.ts));

  const recentlyNagged = await getRecentlyNaggedTs(
    open.map((m) => m.ts),
    frequencyDays,
  );

  const toNag = open.filter((m) => !recentlyNagged.has(m.ts));

  log({
    event: "bot.scan",
    bot: "unanswered-reminder",
    unsolved: unsolved.length,
    after_ignore: candidates.length,
    after_thread_check: open.length,
    to_nag: toNag.length,
    frequency_days: frequencyDays,
  });

  await setSetting(
    "unanswered_reminder.last_scan",
    JSON.stringify({
      at: new Date().toISOString(),
      unsolved: unsolved.length,
      nagged: toNag.length,
    }),
  );

  for (const msg of toNag) {
    try {
      await postReminder(targetChannel, {
        originalChannelId: sourceChannel,
        ts: msg.ts,
        author: msg.user,
        text: msg.text,
        permalink: msg.permalink,
      });
      await upsertNagLog(msg.ts, sourceChannel);
    } catch (err) {
      logError({
        event: "bot.nag_failed",
        ts: msg.ts,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
