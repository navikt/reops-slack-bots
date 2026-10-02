import { WebClient } from "@slack/web-api";
import type { Pool } from "pg";
import { log, logError } from "./log";

let client: WebClient | null = null;

export function getSlackClient(): WebClient {
  if (client) return client;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not set");
  client = new WebClient(token);
  return client;
}

export interface UnsolvedMessage {
  ts: string;
  user: string;
  text: string;
  permalink: string;
}

/**
 * Fetches top-level messages in the channel older than `olderThanDays`,
 * returning those that do NOT have a :solved: reaction.
 *
 * Note on reactions: conversations.history already embeds each message's
 * reactions, so we check those directly and only fall back to reactions.get
 * if reactions are missing from the history payload.
 */
export async function fetchOldUnsolvedMessages(
  channelId: string,
  olderThanDays: number,
): Promise<UnsolvedMessage[]> {
  const web = getSlackClient();
  const cutoff = (Date.now() / 1000 - olderThanDays * 24 * 60 * 60).toFixed(6);

  const unsolved: UnsolvedMessage[] = [];
  let cursor: string | undefined;

  do {
    const res = await web.conversations.history({
      channel: channelId,
      latest: cutoff,
      limit: 200,
      cursor,
    });

    for (const msg of res.messages ?? []) {
      // Only consider top-level user messages (skip replies, bot posts, join/leave notices)
      if (msg.subtype && msg.subtype !== "thread_broadcast") continue;
      if (!msg.ts || !msg.user) continue;

      const solved = (msg.reactions ?? []).some((r) => r.name === "solved");
      if (solved) continue;

      let permalink = "";
      try {
        const pl = await web.chat.getPermalink({ channel: channelId, message_ts: msg.ts });
        permalink = pl.permalink ?? "";
      } catch (err) {
        logError({
          event: "slack.permalink_failed",
          ts: msg.ts,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      unsolved.push({ ts: msg.ts, user: msg.user, text: msg.text ?? "", permalink });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return unsolved;
}

/**
 * Reads the ignore_list table and expands any usergroup rows into member
 * user IDs via usergroups.users.list. Returns all ignored user IDs.
 */
export async function expandIgnoreSet(pgPool: Pool): Promise<Set<string>> {
  const res = await pgPool.query<{ slack_id: string; kind: "user" | "usergroup" }>(
    "SELECT slack_id, kind FROM ignore_list",
  );

  const ignored = new Set<string>();
  const web = getSlackClient();

  for (const row of res.rows) {
    if (row.kind === "user") {
      ignored.add(row.slack_id);
    } else {
      try {
        const members = await web.usergroups.users.list({ usergroup: row.slack_id });
        for (const uid of members.users ?? []) {
          ignored.add(uid);
        }
      } catch (err) {
        // Fail open for this group (skip expansion) but log loudly — a stale
        // usergroup shouldn't kill the whole nag run.
        logError({
          event: "slack.usergroup_expand_failed",
          usergroup: row.slack_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return ignored;
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
  const web = getSlackClient();

  const preview =
    text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;

  const value = JSON.stringify({ channel: originalChannelId, ts });

  const res = await web.chat.postMessage({
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
            text: { type: "plain_text", text: "Merk som løst" },
            action_id: "mark_solved",
            value,
          },
        ],
      },
    ],
  });

  log({ event: "slack.reminder_posted", channel: channelId, original_ts: ts, ok: res.ok === true });
}
