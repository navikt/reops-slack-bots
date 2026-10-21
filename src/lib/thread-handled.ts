/**
 * Is an unanswered-message candidate already handled?
 *
 * Handled signals, in check order:
 *
 * - Team member wrote the last reply → handled.
 * - Manually suppressed via the digest's Suppress button, and the mark is
 *   newer than the last reply → handled. Later thread activity re-opens it.
 * - The newest handled reaction (parent or reply, by message ts) wins if no
 *   non-team reply is newer than it. Anyone — team or the asker — can set
 *   it; a follow-up non-team question re-opens the thread, and re-adding a
 *   handled reaction closes it again. Recognized emoji: see SOLVED_EMOJIS in
 *   slack.ts.
 *
 * Inputs are the thread's full reply list (hydrated via
 * conversations.replies — history's embedded latest_replies proved
 * unreliable on the wire), so this is pure data — no Slack call here.
 */
export function isThreadHandled(
  m: {
    ts: string;
    parentSolved: boolean;
    latestReplies: Array<{ user: string | null; ts: number; solved: boolean }>;
    /** Manual Ignore-mark time (seconds, Slack ts domain) — null if none. */
    ignoredAt: number | null;
  },
  teamUserIds: ReadonlySet<string>,
): boolean {
  const last = m.latestReplies[m.latestReplies.length - 1];
  if (last?.user && teamUserIds.has(last.user)) return true;

  // Manual ignore beats everything below it, until newer thread activity.
  if (m.ignoredAt !== null) {
    const newestReplyTs = Math.max(0, ...m.latestReplies.map((r) => r.ts));
    if (m.ignoredAt >= newestReplyTs) return true;
  }

  // Newest solve signal: parent (ts = message birth) or any reply.
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
