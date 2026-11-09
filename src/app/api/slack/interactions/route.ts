import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  getSetting,
  listIgnoreEmails,
  listIgnoreGroups,
} from "../../../../lib/db";
import { getGroupMemberEmails } from "../../../../lib/auth";
import {
  DIGEST_ASSIGN_ACTION,
  DIGEST_RELEASE_VALUE,
  DIGEST_SUPPRESS_ACTION,
  listAssigneeOptions,
} from "../../../../lib/slack";
import { sourceFromLegacyReminder, type MessageBlock } from "../../../../lib/digest-item-removal";
import { reminders, sourceForReminder } from "../../../../lib/reminders-runtime";
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
 * State changes and all tracked delivery updates share the reminder module.
 * Slack retries non-2xx responses; mutations are serialized by a DB lock.
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
    message?: { ts?: string; blocks?: MessageBlock[] };
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

  const threadTsPattern = /^\d+\.\d+$/;
  for (const action of payload.actions) {
    const suppress = action.action_id === DIGEST_SUPPRESS_ACTION;
    if (!suppress && action.action_id !== DIGEST_ASSIGN_ACTION) continue;
    const messageTs = suppress ? action.value ?? "" : action.block_id?.replace(/^digest_item_/, "") ?? "";
    const assignee = action.selected_user ?? action.selected_option?.value;
    if (!threadTsPattern.test(messageTs) || (!suppress && !assignee) || !digestChannel || !digestTs) {
      return NextResponse.json({ error: "invalid reminder action" }, { status: 400 });
    }
    const sourceChannelId = await sourceForReminder(digestChannel, digestTs, messageTs)
      ?? sourceFromLegacyReminder(payload.message?.blocks ?? [], messageTs)
      ?? (await getSetting("unanswered_reminder.source_channel_id"))
      ?? process.env.RESEARCHOPS_CHANNEL_ID;
    if (!sourceChannelId) return NextResponse.json({ error: "source channel unavailable" }, { status: 409 });
    const kind = suppress ? "suppressed" : assignee === DIGEST_RELEASE_VALUE ? "released" : "assigned";
    try {
      await reminders.act({
        sourceChannelId,
        threadTs: messageTs,
        action: kind,
        actor,
        assignee,
        roster: await buildRoster(),
        clicked: { channelId: digestChannel, deliveryTs: digestTs, blocks: payload.message?.blocks ?? [] },
      });
      log({ event: `slack.thread_${kind}`, message_ts: messageTs, assignee, by: actor });
    } catch (err) {
      logError({ event: "slack.reminder_action_failed", message_ts: messageTs, message: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ error: "reminder update failed; retry" }, { status: 503 });
    }
  }

  return NextResponse.json({ ok: true });
}
