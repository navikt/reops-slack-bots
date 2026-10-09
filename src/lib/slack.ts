import { WebClient } from "@slack/web-api";
import { log, logDebug, logError } from "./log";
import { getSetting } from "./db";
import { graceEligibleTs } from "./work-hours";

export { isThreadHandled } from "./thread-handled";

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
 * The bot's own Slack identity, resolved once via auth.test (no scopes
 * needed). Bot-posted messages carry `bot_id` in conversations.history but
 * often NO `user` field — so excluding by user ID alone leaks. We filter on
 * both. Static per process; the cache never expires.
 */
let selfCache: { userId: string; botId: string } | null = null;

async function getSelfIdentity(): Promise<{ userId: string; botId: string }> {
  if (selfCache) return selfCache;
  const res = await slackCall("auth.test", (web) => web.auth.test());
  if (!res.user_id || !res.bot_id) {
    throw new Error("auth.test missing user_id/bot_id");
  }
  selfCache = { userId: res.user_id, botId: res.bot_id };
  return selfCache;
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
  /** Newest embedded replies (up to 3), oldest first, most recent last. */
  latestReplies: Array<{
    user: string | null;
    ts: number;
    solved: boolean;
  }>;
  /** Parent message carries :solved:. */
  parentSolved: boolean;
}

/**
 * Fetches top-level messages no older than `olderThanDays`, excluding any
 * still inside their grace period. The window bound keeps the scan cheap
 * (never re-reads full history) and stateless (no cursor to lose on
 * restart); the grace filter is work-hours aware (see work-hours.ts), so a
 * message posted Friday evening is not nagged before Monday morning.
 *
 * :solved: is NOT filtered here — it is a recency-based handled signal, not
 * a veto. See isThreadHandled.
 */
export async function fetchOldUnsolvedMessages(
  channelId: string,
  olderThanDays: number,
  graceHours: number,
): Promise<UnsolvedMessage[]> {
  const self = await getSelfIdentity();
  const nowS = Date.now() / 1000;
  const oldest = (nowS - olderThanDays * 24 * 60 * 60).toFixed(6);
  // Grace is work-hours aware and per-message, so we cannot push it into the
  // history `latest` bound — fetch the whole window and filter below.
  const latest = nowS.toFixed(6);

  const unsolved: UnsolvedMessage[] = [];
  let cursor: string | undefined;

  do {
    const res = await slackCall("conversations.history", (web) =>
      web.conversations.history({ channel: channelId, oldest, latest, limit: 200, cursor }),
    );

    for (const msg of res.messages ?? []) {
      // Only consider top-level user messages (skip replies, bot posts,
      // join/leave notices)
      if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
      if (!msg.ts || !msg.user) continue;
      // Never nag about ourselves. Bot posts can lack `subtype`/`user`
      // filtering hooks, so match on identity: bot_id (primary) or user.
      const botId = (msg as { bot_id?: string }).bot_id;
      if (botId === self.botId || msg.user === self.userId) continue;

      // Still inside its (work-hours aware) grace period — too fresh to nag.
      if (graceEligibleTs(msg.ts, graceHours) > nowS) continue;

      // history embeds the 3 newest replies inline — enough to apply the
      // handled rule without a conversations.replies call. The SDK type
      // omits latest_replies; it exists on the wire.
      const latestReplies =
        (msg as {
          latest_replies?: Array<{
            user?: string;
            ts?: string;
            reactions?: Array<{ name: string }>;
          }>;
        }).latest_replies ?? [];

      unsolved.push({
        ts: msg.ts,
        user: msg.user,
        text: msg.text ?? "",
        permalink: buildPermalink(channelId, msg.ts),
        replyCount: msg.reply_count ?? 0,
        latestReplies: latestReplies
          .filter((r) => r.ts)
          .map((r) => ({
            user: r.user ?? null,
            ts: Number.parseFloat(r.ts as string),
            solved: (r.reactions ?? []).some((x) => x.name === "solved"),
          })),
        parentSolved: (msg.reactions ?? []).some((r) => r.name === "solved"),
      });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return unsolved;
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

export interface UnsolvedReminderItem {
  ts: string;
  permalink: string;
}

/** Slack unfurls at most 5 links per message — the digest caps at that. */
const MAX_DIGEST_LINKS = 5;

function formatAge(ts: string, nowMs: number): string {
  const hours = Math.max(0, Math.round((nowMs - Number(ts) * 1000) / 3_600_000));
  if (hours < 48) return `${hours} ${hours === 1 ? "time" : "timer"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "dag" : "dager"}`;
}

/**
 * Posts one digest message per scan to the internal channel. Each line is a
 * bare permalink — Slack auto-unfurls those into message previews, so the
 * message itself stays clean (no quoted text, no channel name, no buttons).
 * Replies to the threads themselves are the workflow; a "resolve" shortcut
 * here would encourage not reading the message.
 */
export async function postUnansweredDigest(
  channelId: string,
  items: UnsolvedReminderItem[],
): Promise<void> {
  if (items.length === 0) return;

  const nowMs = Date.now();
  const shown = items.slice(0, MAX_DIGEST_LINKS);
  const lines = shown.map(
    (m) => `${m.permalink} — ubesvart i ${formatAge(m.ts, nowMs)}`,
  );
  const overflow = items.length - shown.length;
  const countNote =
    overflow > 0
      ? ` (viser ${shown.length} av ${items.length})`
      : items.length > 1
        ? ` (${items.length})`
        : "";
  const rest =
    overflow > 0 ? `\n_…og ${overflow} til i kanalen._` : "";

  const text = `*Ubesvarte meldinger${countNote}*\n${lines.join("\n")}${rest}`;

  const res = await slackCall("chat.postMessage", (web) =>
    web.chat.postMessage({ channel: channelId, text }),
  );

  log({
    event: "slack.digest_posted",
    channel: channelId,
    count: shown.length,
    overflow,
    ok: res.ok === true,
  });
}
