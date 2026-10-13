import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  deleteDigestMessagesForThreads,
  deleteThreadAction,
  listDigestMessages,
  listIgnoreEmails,
  listIgnoreGroups,
  upsertThreadAction,
} from "../../../../lib/db";
import { getGroupMemberEmails } from "../../../../lib/auth";
import {
  DIGEST_ASSIGN_ACTION,
  DIGEST_RELEASE_VALUE,
  DIGEST_SUPPRESS_ACTION,
  dmAssignment,
  listAssigneeOptions,
  updateUnansweredDigest,
} from "../../../../lib/slack";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

/**
 * Slack interactivity webhook — block_actions from digest buttons.
 *
 * Slack signs every request: X-Slack-Signature = HMAC-SHA256(signing secret,
 * "v0:<timestamp>:<raw body>"), X-Slack-Request-Timestamp must be fresh
 * (±5 min replay window). Both headers + the RAW body are required — hence
 * req.text(), never req.json().
 *
 * Setup: the app's Interactivity Request URL must point here
 * (https://reops-slack-bots.nav.no/api/slack/interactions — the PUBLIC
 * ingress; ansatt.nav.no is platform-SSO'd and would 302 the webhook).
 * Signing secret lives in the `reops-slack-bots` secret as
 * SLACK_SIGNING_SECRET.
 *
 * Slack demands a 2xx within 3s; the DB writes + one chat.update are well
 * within that. Feedback is instant: the pressed link disappears from the
 * digest right away (hourly reconciliation is the backstop).
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    logError({ event: "slack.interactions.no_secret" });
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const body = await req.text();
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";

  // Replay window: reject stale timestamps before comparing signatures.
  const nowSec = Math.floor(Date.now() / 1000);
  const ageSec = /^\d+$/.test(ts) ? nowSec - Number(ts) : null;
  if (ageSec === null || Math.abs(ageSec) > 60 * 5) {
    logError({
      event: "slack.interactions.stale_timestamp",
      ts_header: ts,
      age_seconds: ageSec,
    });
    return NextResponse.json({ error: "stale" }, { status: 401 });
  }

  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${ts}:${body}`)
    .digest("hex")}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    // Log only prefixes — enough to distinguish "empty header" vs "wrong
    // secret" without leaking the signature itself.
    logError({
      event: "slack.interactions.bad_signature",
      sig_prefix: sig.slice(0, 12),
      expected_prefix: expected.slice(0, 12),
      body_bytes: body.length,
    });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: {
    type?: string;
    actions?: Array<{
      action_id?: string;
      block_id?: string; // "digest_item_<thread_ts>" on our actions blocks
      value?: string; // buttons
      selected_user?: string; // users_select
      selected_option?: { value?: string }; // static_select / overflow
    }>;
    channel?: { id?: string };
    message?: { ts?: string };
    user?: { id?: string };
  };
  try {
    payload = JSON.parse(
      new URLSearchParams(body).get("payload") ?? "{}",
    ) as typeof payload;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  if (payload.type !== "block_actions" || !payload.actions?.length) {
    // url_verification or unknown types: ack and ignore.
    log({ event: "slack.interactions.acked", payload_type: payload.type ?? "unknown" });
    return NextResponse.json({ ok: true });
  }

  const actor = payload.user?.id ?? "unknown";
  const digestChannel = payload.channel?.id ?? "";
  const digestTs = payload.message?.ts;

  /** Builds the "Assign to…" roster (ignore persons + group members). */
  const buildRoster = async () => {
    const groups = await listIgnoreGroups();
    const groupEmails = (
      await Promise.all(
        groups.map(async (g) => {
          try {
            return await getGroupMemberEmails(g.kind, g.id);
          } catch {
            return [] as string[];
          }
        }),
      )
    ).flat();
    return listAssigneeOptions([
      ...new Set([...(await listIgnoreEmails()), ...groupEmails]),
    ]);
  };

  /** Removes a thread's entry from the digest message it was clicked in. */
  const removeFromDigest = async (messageTs: string) => {
    if (!digestTs || !digestChannel) return;
    try {
      const tracked = await listDigestMessages();
      const here = tracked.filter((r) => r.digest_ts === digestTs);
      const remaining = here.filter((r) => r.message_ts !== messageTs);
      // Roster rebuilt on every press — without it the Assign select
      // disappears from the rewritten digest until the next hourly scan.
      const roster = await buildRoster();
      await updateUnansweredDigest(
        digestChannel,
        digestTs,
        remaining.map((r) => ({
          ts: r.message_ts,
          permalink: r.permalink,
          text: r.text_excerpt,
          authorLabel: r.author_label,
          imageUrl: r.image_url,
        })),
        // Best-effort total for the header line.
        tracked.length - here.length + remaining.length,
        roster,
      );
      await deleteDigestMessagesForThreads([messageTs]);
    } catch (err) {
      logError({
        event: "slack.digest_instant_update_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  for (const action of payload.actions) {
    if (action.action_id === DIGEST_SUPPRESS_ACTION && action.value) {
      const messageTs = action.value;
      // thread_actions keys on message_ts only; the digest channel is stored
      // for traceability, not because the thread lives there (it doesn't).
      await upsertThreadAction(messageTs, digestChannel, "suppressed", actor);
      log({ event: "slack.thread_suppressed", message_ts: messageTs, by: actor });
      await removeFromDigest(messageTs);
      continue;
    }

    if (action.action_id === DIGEST_ASSIGN_ACTION) {
      const selected = action.selected_user ?? action.selected_option?.value;
      // thread ts comes from the enclosing actions block's block_id
      // (`digest_item_<ts>`) — users_select has no `value` field.
      const messageTs = action.block_id?.replace(/^digest_item_/, "") ?? "";
      const assignee = selected;
      if (!messageTs || !assignee) {
        logError({ event: "slack.assign_no_block_id", block_id: action.block_id });
        continue;
      }

      // "I don't know / release" — clear the assignment; the thread
      // re-enters the channel digest on the next scan's nag cycle.
      if (assignee === DIGEST_RELEASE_VALUE) {
        await deleteThreadAction(messageTs);
        log({
          event: "slack.thread_released",
          message_ts: messageTs,
          by: actor,
        });
        continue;
      }

      await upsertThreadAction(messageTs, digestChannel, "assigned", actor, assignee);
      log({
        event: "slack.thread_assigned",
        message_ts: messageTs,
        assignee,
        by: actor,
      });

      // DM the assignee with the same preview + controls (Suppress +
      // re-assign picker, roster minus the new assignee).
      try {
        const row = (await listDigestMessages()).find((r) => r.message_ts === messageTs);
        const roster = await buildRoster();
        await dmAssignment(
          assignee,
          {
            ts: messageTs,
            permalink: row?.permalink ?? "",
            text: row?.text_excerpt ?? "",
            authorLabel: row?.author_label ?? "?",
            imageUrl: row?.image_url ?? null,
          },
          roster,
          actor,
        );
      } catch (err) {
        logError({
          event: "slack.assignment_dm_failed",
          message_ts: messageTs,
          assignee,
          message: err instanceof Error ? err.message : String(err),
        });
      }

      await removeFromDigest(messageTs);
    }
  }

  return NextResponse.json({ ok: true });
}
