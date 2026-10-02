import {
  getPool,
  getRecentlyNaggedTs,
  getSetting,
  upsertNagLog,
} from "../../lib/db";
import { expandIgnoreSet, fetchOldUnsolvedMessages, postReminder } from "../../lib/slack";
import { log, logError } from "../../lib/log";

const DEFAULT_NAG_FREQUENCY_DAYS = 7;

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

  const sourceChannel = process.env.RESEARCHOPS_CHANNEL_ID;
  const targetChannel = process.env.RESEARCHOPS_INTERN_CHANNEL_ID;
  if (!sourceChannel || !targetChannel) {
    logError({
      event: "bot.missing_env",
      has_source: Boolean(sourceChannel),
      has_target: Boolean(targetChannel),
    });
    return;
  }

  const pool = getPool();
  const ignoreSet = await expandIgnoreSet(pool);
  const unsolved = await fetchOldUnsolvedMessages(sourceChannel, frequencyDays);

  const candidates = unsolved.filter((m) => !ignoreSet.has(m.user));

  const recentlyNagged = await getRecentlyNaggedTs(
    candidates.map((m) => m.ts),
    frequencyDays,
  );

  const toNag = candidates.filter((m) => !recentlyNagged.has(m.ts));

  log({
    event: "bot.scan",
    bot: "unanswered-reminder",
    unsolved: unsolved.length,
    after_ignore: candidates.length,
    to_nag: toNag.length,
    frequency_days: frequencyDays,
  });

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
