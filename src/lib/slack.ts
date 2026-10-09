import { WebClient } from "@slack/web-api";
import { log, logDebug, logError } from "./log";
import { getSetting } from "./db";

let client: WebClient | null = null;

function getSlackClientRaw(): WebClient {
  if (client) return client;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  client = new WebClient(token, {
    // Silence the SDK's console spam — we log calls ourselves via slackCall.
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      setLevel: () => undefined,
      setName: () => undefined,
      getLevel: () => 0 as never,
    },
  });
  return client;
}

/**
 * Logs each outbound Slack call — Slack rate limits are per method per
 * workspace, so a 429 is only actionable if our logs name the method.
 * Rate-limit errors carry the Retry-After value; surface it.
 */
async function slackCall<T>(method: string, fn: (web: WebClient) => Promise<T>): Promise<T> {
  const web = await getSlackClient();
  const start = Date.now();
  try {
    const res = await fn(web);
    log({ event: "slack.api", method, duration_ms: Date.now() - start });
    return res;
  } catch (err) {
    // WebAPIRateLimitedError exposes .retryAfter (seconds, parsed from the
    // Retry-After header); generic errors may carry raw headers instead.
    const e = err as { retryAfter?: number; headers?: Record<string, string> };
    const retryAfter = e.retryAfter ?? e.headers?.["retry-after"] ?? null;
    logError({
      event: "slack.api_failed",
      method,
      duration_ms: Date.now() - start,
      retry_after_s: retryAfter,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Kill switch: when the `frozen` setting is "true", every outbound Slack
 * call short-circuits. Lets anyone on the team freeze the bot from /admin
 * without touching infra. The DB read is cached briefly so a frozen bot
 * doesn't hammer Postgres either.
 */
const FROZEN_CHECK_TTL_MS = 10 * 1000;
let frozenCache: { at: number; frozen: boolean } | null = null;

async function isFrozen(): Promise<boolean> {
  if (frozenCache && Date.now() - frozenCache.at < FROZEN_CHECK_TTL_MS) {
    return frozenCache.frozen;
  }
  const frozen = (await getSetting("frozen")) === "true";
  frozenCache = { at: Date.now(), frozen };
  return frozen;
}

export class SlackFrozenError extends Error {
  constructor() {
    super("Bot is frozen via admin kill switch");
    this.name = "SlackFrozenError";
  }
}

export async function getSlackClient(): Promise<WebClient> {
  if (await isFrozen()) throw new SlackFrozenError();
  return getSlackClientRaw();
}

/** Lets interactivity verify state without unfreezing reads. */
export async function botIsFrozen(): Promise<boolean> {
  return isFrozen();
}

export interface JoinedChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

// users.conversations lists only channels the BOT is a member of (Tier 3,
// 50+/min) — unlike conversations.list, which pages the entire workspace.
// The roster only changes when someone /invites the bot, so cache it
// in-process instead of calling Slack on every page render.
const CHANNELS_CACHE_TTL_MS = 60 * 1000;
let channelsCache: { at: number; channels: JoinedChannel[] } | null = null;

/**
 * Lists channels the bot is a member of (public + private). Powers the
 * channel pickers in /admin — "invite the bot to a channel to have it
 * appear here". Cached for 60s; invite -> visible within a minute.
 */
export async function listJoinedChannels(): Promise<JoinedChannel[]> {
  if (channelsCache && Date.now() - channelsCache.at < CHANNELS_CACHE_TTL_MS) {
    return channelsCache.channels;
  }

  const channels: JoinedChannel[] = [];
  let cursor: string | undefined;

  do {
    const res = await slackCall("users.conversations", (web) =>
      web.users.conversations({
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        cursor,
      }),
    );

    for (const ch of res.channels ?? []) {
      if (!ch.id || !ch.name) continue;
      channels.push({ id: ch.id, name: ch.name, isPrivate: ch.is_private === true });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  channels.sort((a, b) => a.name.localeCompare(b.name));
  channelsCache = { at: Date.now(), channels };
  return channels;
}

/**
 * Slack permalinks are deterministic, documented URL math — skip the
 * chat.getPermalink API call entirely:
 *   https://{workspace}.slack.com/archives/{channel}/p{ts without the dot}
 */
function buildPermalink(channelId: string, ts: string): string {
  const workspace = process.env.SLACK_WORKSPACE_SUBDOMAIN ?? "nav";
  return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export interface UnsolvedMessage {
  ts: string;
  user: string;
  text: string;
  permalink: string;
  replyCount: number;
  /** User IDs of the newest replies (up to 3), most recent last. */
  latestReplyUsers: string[];
}

/**
 * Fetches top-level messages in a bounded window:
 * older than `olderThanDays` but younger than `youngerThanHours`.
 * The upper bound keeps the scan cheap (never re-reads full history) and
 * stateless (no cursor to lose on restart); the lower bound gives people a
 * grace period to answer before the bot considers a message "unanswered".
 *
 * Only messages without a :solved: reaction on the parent are returned.
 */
export async function fetchOldUnsolvedMessages(
  channelId: string,
  olderThanDays: number,
  youngerThanHours: number,
): Promise<UnsolvedMessage[]> {
  const nowS = Date.now() / 1000;
  const oldest = (nowS - olderThanDays * 24 * 60 * 60).toFixed(6);
  const latest = (nowS - youngerThanHours * 60 * 60).toFixed(6);

  const unsolved: UnsolvedMessage[] = [];
  let cursor: string | undefined;

  do {
    const res = await slackCall("conversations.history", (web) =>
      web.conversations.history({ channel: channelId, oldest, latest, limit: 200, cursor }),
    );

    for (const msg of res.messages ?? []) {
      // Only consider top-level user messages (skip replies, bot posts, join/leave notices)
      if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
      if (!msg.ts || !msg.user) continue;

      const solved = (msg.reactions ?? []).some((r) => r.name === "solved");
      if (solved) continue;

      unsolved.push({
        ts: msg.ts,
        user: msg.user,
        text: msg.text ?? "",
        permalink: buildPermalink(channelId, msg.ts),
        replyCount: msg.reply_count ?? 0,
        // history embeds the 3 newest replies inline — enough to read the
        // last reply author without a conversations.replies call. The SDK
        // type omits latest_replies; it exists on the wire.
        latestReplyUsers: (
          (msg as { latest_replies?: Array<{ user?: string }> }).latest_replies ?? []
        )
          .map((r) => r.user)
          .filter((u): u is string => Boolean(u)),
      });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return unsolved;
}

/**
 * Decides whether a thread is already "handled": either the last reply was
 * written by someone on the ignore list (team member), or any message in the
 * thread carries a :solved: reaction. A later reply from a non-team user
 * flips it back to nag-worthy on the next run.
 *
 * Fail-open on API errors: returns false so the message still gets nagged
 * rather than silently dropped.
 */
export async function isThreadHandled(
  channelId: string,
  threadTs: string,
  ignoreSet: ReadonlySet<string>,
): Promise<boolean> {

  try {
    const res = await slackCall("conversations.replies", (web) =>
      web.conversations.replies({ channel: channelId, ts: threadTs }),
    );
    const messages = res.messages ?? [];
    if (messages.length === 0) return false;

    const hasSolvedReaction = messages.some((m) =>
      (m.reactions ?? []).some((r) => r.name === "solved"),
    );
    if (hasSolvedReaction) return true;

    const last = messages[messages.length - 1];
    return Boolean(last.user && ignoreSet.has(last.user));
  } catch (err) {
    logError({
      event: "slack.thread_check_failed",
      ts: threadTs,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Resolves team emails to Slack user IDs via users.lookupByEmail (requires
 * users:read.email scope). Cached for the process lifetime — membership
 * drift is picked up on restart / hourly re-expansion, both fine.
 * Unknown emails are skipped with a debug log, not fatal.
 */
const emailToUserCache = new Map<string, string | null>();

export async function resolveEmailsToUserIds(emails: string[]): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const email of emails) {
    const key = email.toLowerCase();
    if (emailToUserCache.has(key)) {
      const cached = emailToUserCache.get(key);
      if (cached) ids.add(cached);
      continue;
    }
    try {
      const res = await slackCall("users.lookupByEmail", (web) =>
        web.users.lookupByEmail({ email }),
      );
      const uid = res.user?.id ?? null;
      emailToUserCache.set(key, uid);
      if (uid) {
        ids.add(uid);
        logDebug({ event: "slack.email_resolved", email, user: uid });
      } else {
        logDebug({ event: "slack.email_unresolved", email });
      }
    } catch (err) {
      emailToUserCache.set(key, null);
      logDebug({
        event: "slack.email_lookup_failed",
        email,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return ids;
}

/**
 * Resolves a list of email addresses to Slack user IDs — the full ignore
 * set for a scan. Email is the shared identity key between Team Catalog
 * and Slack (both fed by Nav AD).
 */
export async function expandIgnoreSet(emails: string[]): Promise<Set<string>> {
  return resolveEmailsToUserIds(emails);
}

export interface ReminderPayload {
  originalChannelId: string;
  ts: string;
  author: string;
  text: string;
  permalink: string;
}

const MAX_PREVIEW_LENGTH = 300;

/**
 * Posts a Block Kit reminder to the internal channel with a "Merk som løst"
 * button. The button value carries the original channel+ts as JSON so the
 * interactivity endpoint can add :solved: to the right message.
 */
export async function postReminder(
  channelId: string,
  { originalChannelId, ts, author, text, permalink }: ReminderPayload,
): Promise<void> {

  const preview =
    text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;

  const value = JSON.stringify({ channel: originalChannelId, ts });

  const res = await slackCall("chat.postMessage", (web) =>
    web.chat.postMessage({
    channel: channelId,
    text: `Ubesvart melding fra <@${author}> i <#${originalChannelId}>: ${permalink}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:bell: *Ubesvart melding i <#${originalChannelId}>*\n<@${author}> spurte:\n>${preview.replace(/\n/g, "\n>")}\n\n<${permalink}|Åpne meldingen i Slack>`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: ":solved: Mark as solved", emoji: true },
            action_id: "mark_solved",
            value,
          },
        ],
      },
    ],
    }),
  );

  log({ event: "slack.reminder_posted", channel: channelId, original_ts: ts, ok: res.ok === true });
}
