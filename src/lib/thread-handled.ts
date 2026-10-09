/**
 * Is an unanswered-message candidate already handled?
 *
 * :solved: and a team reply are equal-rank "handled" signals, and recency
 * decides. All inputs come embedded in conversations.history (the 3 newest
 * replies), so this is pure data — no Slack call:
 *
 * - Team member wrote the last reply → handled.
 * - Otherwise: the newest :solved: (parent or reply, by message ts) wins if
 *   no non-team reply is newer than it. Anyone — team or the asker — can set
 *   it; a follow-up non-team question re-opens the thread, and re-adding
 *   :solved: closes it again.
 *
 * Caveat: with only the 3 newest replies embedded, a :solved: on an older
 * reply scrolled out of the window is missed (worst case: one extra nag,
 * then someone re-marks). Acceptable vs a conversations.replies call per
 * thread.
 */
export function isThreadHandled(
  m: {
    ts: string;
    parentSolved: boolean;
    latestReplies: Array<{ user: string | null; ts: number; solved: boolean }>;
  },
  teamUserIds: ReadonlySet<string>,
): boolean {
  const last = m.latestReplies[m.latestReplies.length - 1];
  if (last?.user && teamUserIds.has(last.user)) return true;

  // Newest solve signal: parent (ts = message birth) or any embedded reply.
  const newestSolveTs = Math.max(
    m.parentSolved ? Number.parseFloat(m.ts) : 0,
    ...m.latestReplies.filter((r) => r.solved).map((r) => r.ts),
  );
  if (newestSolveTs === 0) return false;

  // A non-team reply newer than the solve re-opens the thread.
  const newestNonTeamReplyTs = Math.max(
    0,
    ...m.latestReplies
      .filter((r) => !r.user || !teamUserIds.has(r.user))
      .map((r) => r.ts),
  );
  return newestSolveTs >= newestNonTeamReplyTs;
}
