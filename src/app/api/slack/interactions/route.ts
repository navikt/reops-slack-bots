import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  deleteDigestMessagesForThreads,
  listDigestMessages,
  upsertThreadAction,
} from "../../../../lib/db";
import {
  DIGEST_SUPPRESS_ACTION,
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
 * (https://<host>/api/slack/interactions) — see README. Signing secret lives
 * in the `reops-slack-bots` secret as SLACK_SIGNING_SECRET.
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
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) {
    return NextResponse.json({ error: "stale" }, { status: 401 });
  }

  const expected = `v0=${createHmac("sha256", secret)
    .update(`v0:${ts}:${body}`)
    .digest("hex")}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    logError({ event: "slack.interactions.bad_signature" });
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let payload: {
    type?: string;
    actions?: Array<{ action_id?: string; value?: string }>;
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
    return NextResponse.json({ ok: true });
  }

  for (const action of payload.actions) {
    if (action.action_id !== DIGEST_SUPPRESS_ACTION || !action.value) continue;
    const messageTs = action.value;
    const digestChannel = payload.channel?.id ?? "";
    const digestTs = payload.message?.ts;
    const actor = payload.user?.id ?? "unknown";

    // thread_actions keys on message_ts only; the digest channel is stored
    // for traceability, not because the thread lives there (it doesn't).
    await upsertThreadAction(messageTs, digestChannel, "suppressed", actor);
    log({ event: "slack.thread_suppressed", message_ts: messageTs, by: actor });

    // Instant feedback: remove the link from this digest message now.
    if (digestTs && digestChannel) {
      try {
        const tracked = await listDigestMessages();
        const here = tracked.filter((r) => r.digest_ts === digestTs);
        const remaining = here.filter((r) => r.message_ts !== messageTs);
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
        );
        await deleteDigestMessagesForThreads([messageTs]);
      } catch (err) {
        logError({
          event: "slack.digest_instant_update_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
