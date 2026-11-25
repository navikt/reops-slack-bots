import type { ReminderItem } from "./reminders.ts";

const HOUR_MS = 3_600_000;
const YEAR_MS = 365 * 24 * HOUR_MS;

function formatAge(ageMs: number): string {
  const hours = Math.max(0, Math.round(ageMs / HOUR_MS));
  if (hours < 48) return `${hours} ${hours === 1 ? "time" : "timer"}`;
  return `${Math.round(hours / 24)} dager`;
}

export function reminderAgeLabels(item: Pick<ReminderItem, "ts" | "permalink">, nowMs: number) {
  // The cached permalink identifies the exact message shown, even when a
  // reminder is rebuilt from the DB without fetching the thread again.
  const linkedTs = item.permalink.match(/^https:\/\/[^/]+\.slack\.com\/archives\/[^/]+\/p(\d+)(\d{6})(?:\?|$)/);
  if (!linkedTs) return null;

  const messageMs = Number(`${linkedTs[1]}.${linkedTs[2]}`) * 1000;
  const threadMs = Number(item.ts) * 1000;
  const threadAgeMs = nowMs - threadMs;
  return {
    unanswered: `ubesvart i ${formatAge(nowMs - messageMs)}`,
    threadStarted: messageMs !== threadMs ? `Tråden startet for ${formatAge(threadAgeMs)} siden` : null,
    oldButGold: threadAgeMs > YEAR_MS,
  };
}
