/** Used only until an admin saves a list (including an explicitly empty list). */
export const DEFAULT_HANDLED_EMOJIS: readonly string[] = [
  "raised_hands",
  "solved",
  "dart",
  "heart",
  "heartpulse",
  "meow_heart",
  "white_check_mark",
];

export const HANDLED_EMOJIS_SETTING = "unanswered_reminder.handled_emojis";

/** Accept Slack names, optionally wrapped in colons, separated by commas/space. */
export function parseHandledEmojis(value: string): string[] {
  if (value.length > 10_000) throw new Error("Handled emoji list is too long.");
  const names = value.trim().split(/[,\s]+/).filter(Boolean).map((token) => {
    const name = token.replace(/^:([^:]+):$/, "$1");
    if (!/^[a-zA-Z0-9_+\-]+$/.test(name)) {
      throw new Error(`Invalid emoji name: ${token}. Use Slack names such as :white_check_mark:, not emoji characters.`);
    }
    return name;
  });
  return [...new Set(names)];
}

/** Canonical Slack values with consistent colon-wrapped labels for the UI. */
export function handledEmojiOptions(names: readonly string[]) {
  return parseHandledEmojis(names.join(", ")).map((name) => ({
    value: name,
    label: `:${name}:`,
  }));
}

/** An explicitly empty setting disables reaction-based handling. */
export function getHandledEmojis(value: string | null): string[] {
  return value === null ? [...DEFAULT_HANDLED_EMOJIS] : parseHandledEmojis(value);
}

export function hasHandledReaction(
  reactions: Array<{ name?: string }> | undefined,
  emojis: ReadonlySet<string>,
): boolean {
  return (reactions ?? []).some((r) => r.name !== undefined && emojis.has(r.name));
}
