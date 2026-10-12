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
export function buildPermalink(channelId: string, ts: string): string {
  const workspace = process.env.SLACK_WORKSPACE_SUBDOMAIN ?? "nav";
  return `https://${workspace}.slack.com/archives/${channelId}/p${ts.replace(".", "")}`;
}

export interface UnsolvedMessage {
  ts: string;
  user: string;
  text: string;
  /** Permalink to the LATEST activity — thread reply when replies exist. */
  permalink: string;
  /** Author of the latest reply (null when no replies) — preview matches link. */
  latestUser: string | null;
  /** Text of the latest reply (null when no replies). */
  latestText: string | null;
  /** First image of the latest reply, thumbnailed in the digest (null if none). */
  latestImage: string | null;
  replyCount: number;
  /** All thread replies (hydrated via conversations.replies), oldest first. */
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
 *
 * Thread replies: conversations.history's embedded `latest_replies` does not
 * reliably carry author/reaction data (observed on the wire as ts-only
 * stubs), so threads with replies are hydrated via conversations.replies —
 * one call per thread, few per scan at hourly cadence. Bonus: we see ALL
 * replies, not just the 3 newest, so a :solved: deep in a long thread is no
 * longer missed.
 */
export async function fetchOldUnsolvedMessages(
  channelId: string,
  olderThanDays: number,
  graceHours: number,
  workHoursAware = true,
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
      if (graceEligibleTs(msg.ts, graceHours, workHoursAware) > nowS) continue;

      const replyCount = msg.reply_count ?? 0;

      unsolved.push({
        ts: msg.ts,
        user: msg.user,
        text: msg.text ?? "",
        permalink: buildPermalink(channelId, msg.ts),
        latestUser: null,
        latestText: null,
        latestImage: null,
        replyCount,
        // Hydrated below for threaded messages.
        latestReplies: [],
        parentSolved: (msg.reactions ?? []).some((r) => r.name === "solved"),
      });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  // Hydrate threads: full reply list with authors + reactions. Replies are
  // returned oldest-first; index 0 is the parent itself — skip it. The
  // permalink points at the newest reply (latest activity) so clicking
  // through lands where the conversation actually is.
  for (const m of unsolved) {
    if (m.replyCount === 0) continue;
    try {
      const res = await slackCall("conversations.replies", (web) =>
        web.conversations.replies({ channel: channelId, ts: m.ts, limit: 200 }),
      );
      const replies = (res.messages ?? []).slice(1).filter((r) => r.ts);
      m.latestReplies = replies.map((r) => ({
        user: r.user ?? null,
        ts: Number.parseFloat(r.ts as string),
        solved: (r.reactions ?? []).some((x) => x.name === "solved"),
      }));
      const newest = replies[replies.length - 1];
      if (newest?.ts) {
        m.permalink = buildPermalink(channelId, newest.ts);
        m.latestUser = newest.user ?? null;
        m.latestText = newest.text ?? "";
        // Preview an attached image if the latest reply has one (thumb_360
        // is Slack's pre-sized variant; url_private works because the bot
        // token is sent with the request by Slack clients... actually no —
        // url_private needs auth headers; permalink only. Use thumb URL when
        // present, which Slack renders inline for the bot's own posts.
        const file = (newest.files ?? []).find((f) =>
          (f.mimetype ?? "").startsWith("image/"),
        );
        m.latestImage =
          file?.thumb_360 ?? file?.thumb_160 ?? file?.url_private ?? null;
      }
    } catch (err) {
      // Missing reply data must not kill the scan — fall back to "no reply
      // info", which treats the thread as unanswered (safe direction: an
      // extra nag beats silence).
      logError({
        event: "slack.replies_fetch_failed",
        ts: m.ts,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return unsolved;
}

/**
 * Resolves team emails to Slack user IDs via users.lookupByEmail (requires
 * users:read + users:read.email scopes). Cached with a TTL matching the
 * hourly scan cadence — real answers (found or genuinely not-found) are
 * reused for up to EMAIL_CACHE_TTL_MS so new team members get picked up
 * within about an hour, not only on process restart.
 *
 * Transient failures (rate limit, timeout, missing_scope, etc.) are never
 * cached — those say nothing about the email itself, only that the call
 * broke. Caching them would silently and permanently exclude someone from
 * the ignore set the moment Slack hiccups once.
 */
const EMAIL_CACHE_TTL_MS = 60 * 60 * 1000;
const emailToUserCache = new Map<string, { uid: string | null; cachedAt: number }>();

export async function resolveEmailsToUserIds(emails: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const now = Date.now();

  for (const email of emails) {
    const key = email.toLowerCase();
    const cached = emailToUserCache.get(key);
    if (cached && now - cached.cachedAt < EMAIL_CACHE_TTL_MS) {
      if (cached.uid) ids.add(cached.uid);
      continue;
    }
    try {
      const res = await slackCall("users.lookupByEmail", (web) =>
        web.users.lookupByEmail({ email }),
      );
      const uid = res.user?.id ?? null;
      emailToUserCache.set(key, { uid, cachedAt: now });
      if (uid) {
        ids.add(uid);
        logDebug({ event: "slack.email_resolved", email, user: uid });
      } else {
        logDebug({ event: "slack.email_unresolved", email });
      }
    } catch (err) {
      // Do NOT cache — a transient API failure is not a verdict on the
      // email. Fall back to a stale-but-real cached answer if we have one,
      // so one bad call doesn't un-ignore someone we previously resolved.
      if (cached?.uid) ids.add(cached.uid);
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

/**
 * users.info display-name lookup with a long-lived in-process cache (names
 * change rarely). Falls back to the raw UID on any failure — the digest
 * stays readable either way.
 */
const userLabelCache = new Map<string, { label: string; cachedAt: number }>();
const USER_LABEL_TTL_MS = 24 * 60 * 60 * 1000;

export async function resolveUserLabels(
  userIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const now = Date.now();
  for (const uid of [...new Set(userIds)]) {
    const cached = userLabelCache.get(uid);
    if (cached && now - cached.cachedAt < USER_LABEL_TTL_MS) {
      out.set(uid, cached.label);
      continue;
    }
    try {
      const res = await slackCall("users.info", (web) =>
        web.users.info({ user: uid }),
      );
      const label =
        res.user?.profile?.display_name ||
        res.user?.real_name ||
        res.user?.name ||
        uid;
      userLabelCache.set(uid, { label, cachedAt: now });
      out.set(uid, label);
    } catch {
      out.set(uid, uid); // don't cache failures — next scan retries
    }
  }
  return out;
}

export interface UnsolvedReminderItem {
  ts: string;
  permalink: string;
  /** Excerpt of the previewed message (latest reply when threaded). */
  text: string;
  /** Display label for the previewed message's author. */
  authorLabel: string;
  /** Optional image thumb URL attached to the previewed message. */
  imageUrl: string | null;
}

/** action_id for the per-item Suppress button; value carries the thread ts. */
export const DIGEST_SUPPRESS_ACTION = "digest_suppress";

/** Max items per digest message — Slack allows 50 blocks; we use 4/item. */
const MAX_DIGEST_ITEMS = 12;

function formatAge(ts: string, nowMs: number): string {
  const hours = Math.max(0, Math.round((nowMs - Number(ts) * 1000) / 3_600_000));
  if (hours < 48) return `${hours} ${hours === 1 ? "time" : "timer"}`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "dag" : "dager"}`;
}

function excerpt(text: string, max = 220): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

type DigestBlock =
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | {
      type: "context";
      elements: Array<{ type: "mrkdwn" | "image"; text?: string; image_url?: string; alt_text?: string }>;
    }
  | {
      type: "actions";
      elements: Array<{
        type: "button";
        text: { type: "plain_text"; text: string };
        action_id: string;
        value: string;
      }>;
    }
  | { type: "divider" };

/**
 * Builds the blocks/text for one digest message — shared by post + update.
 *
 * Custom "previews" instead of native unfurls. Each item renders as:
 *   section — *author* · age · åpne tråd
 *   context — > excerpt of the previewed message (+ image thumb when present)
 *   actions — [Suppress] button directly under its preview
 *   divider
 * Posting passes unfurl_links:false, so native previews never batch below
 * the message and every button stays glued to its item.
 */
function buildDigestBlocks(
  items: UnsolvedReminderItem[],
  total: number,
  part: number,
  parts: number,
  nowMs: number,
): { text: string; blocks: DigestBlock[] } {
  const partNote = parts > 1 ? ` (del ${part} av ${parts})` : "";
  const header: DigestBlock = {
    type: "section",
    text: { type: "mrkdwn", text: `*Ubesvarte meldinger (${total})${partNote}*` },
  };
  const blocks: DigestBlock[] = [header, { type: "divider" }];
  for (const [i, m] of items.entries()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${m.authorLabel}* · ubesvart i ${formatAge(m.ts, nowMs)} · <${m.permalink}|åpne tråd>`,
      },
    });
    const quote: DigestBlock = {
      type: "context",
      elements: [{ type: "mrkdwn", text: `>${excerpt(m.text)}` }],
    };
    if (m.imageUrl) {
      quote.elements.push({
        type: "image",
        image_url: m.imageUrl,
        alt_text: "vedlegg",
      });
    }
    blocks.push(quote);
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Suppress" },
          action_id: DIGEST_SUPPRESS_ACTION,
          value: m.ts,
        },
      ],
    });
    if (i < items.length - 1) blocks.push({ type: "divider" });
  }
  // Plain-text fallback for notifications / screen readers.
  const text = `Ubesvarte meldinger (${total})${partNote}\n${items
    .map((m) => `${m.authorLabel}: ${excerpt(m.text, 80)} — ${m.permalink}`)
    .join("\n")}`;
  return { text, blocks };
}

/**
 * Posts the unanswered-messages digest to the internal channel and returns
 * the posted message ts + items per message, so callers can track which
 * digest carries which thread (digest_messages table) for reconciliation.
 */
export async function postUnansweredDigest(
  channelId: string,
  items: UnsolvedReminderItem[],
): Promise<Array<{ digestTs: string; items: UnsolvedReminderItem[] }>> {
  if (items.length === 0) return [];

  const nowMs = Date.now();
  const chunks: UnsolvedReminderItem[][] = [];
  for (let i = 0; i < items.length; i += MAX_DIGEST_ITEMS) {
    chunks.push(items.slice(i, i + MAX_DIGEST_ITEMS));
  }

  const posted: Array<{ digestTs: string; items: UnsolvedReminderItem[] }> = [];

  for (const [idx, chunk] of chunks.entries()) {
    const { text, blocks } = buildDigestBlocks(
      chunk,
      items.length,
      idx + 1,
      chunks.length,
      nowMs,
    );

    const res = await slackCall("chat.postMessage", (web) =>
      web.chat.postMessage({
        channel: channelId,
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );

    log({
      event: "slack.digest_posted",
      channel: channelId,
      count: chunk.length,
      total: items.length,
      part: idx + 1,
      parts: chunks.length,
      ok: res.ok === true,
    });

    if (res.ok && res.ts) {
      posted.push({ digestTs: res.ts, items: chunk });
    }
  }

  return posted;
}

/** Deletes a previously posted digest message (replaced by a fresh one). */
export async function deleteDigestMessage(
  channelId: string,
  digestTs: string,
): Promise<void> {
  await slackCall("chat.delete", (web) =>
    web.chat.delete({ channel: channelId, ts: digestTs }),
  );
  log({ event: "slack.digest_deleted", channel: channelId, ts: digestTs });
}

/**
 * Reconciliation: rewrite a previously posted digest to only the still-open
 * items, or delete it when none remain. Called after each scan (and after
 * Suppress presses) so digests shrink as threads get handled.
 */
export async function updateUnansweredDigest(
  channelId: string,
  digestTs: string,
  remaining: UnsolvedReminderItem[],
  total: number,
): Promise<void> {
  if (remaining.length === 0) {
    await slackCall("chat.delete", (web) =>
      web.chat.delete({ channel: channelId, ts: digestTs }),
    );
    log({ event: "slack.digest_deleted", channel: channelId, ts: digestTs });
    return;
  }
  const { text, blocks } = buildDigestBlocks(remaining, total, 1, 1, Date.now());
  await slackCall("chat.update", (web) =>
    // unfurl_* is valid on chat.update per Web API docs; the SDK's
    // ChatUpdateArguments type lags behind.
    web.chat.update({
      channel: channelId,
      ts: digestTs,
      text,
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    } as Parameters<typeof web.chat.update>[0]),
  );
  log({
    event: "slack.digest_updated",
    channel: channelId,
    ts: digestTs,
    remaining: remaining.length,
  });
}
