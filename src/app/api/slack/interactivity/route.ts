import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSlackClient } from "../../../../lib/slack";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

const FIVE_MINUTES_S = 60 * 5;

/**
 * Verifies Slack's request signature per
 * https://docs.slack.dev/authentication/verifying-requests-from-slack/
 * basestring: "v0:{timestamp}:{rawBody}", HMAC-SHA256 with the signing secret,
 * compare hex digest prefixed with "v0=" using a timing-safe comparison.
 */
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES_S) {
    return false;
  }
  const basestring = `v0:${timestamp}:${rawBody}`;
  const digest =
    "v0=" + createHmac("sha256", signingSecret).update(basestring, "utf8").digest("hex");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

interface BlockActionsPayload {
  type: string;
  user?: { id?: string; username?: string };
  actions?: Array<{ action_id?: string; value?: string }>;
  response_url?: string;
}

export async function POST(req: Request): Promise<Response> {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    logError({ event: "interactivity.no_signing_secret" });
    return new NextResponse("Server misconfigured", { status: 500 });
  }

  const rawBody = await req.text();
  const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
  const signature = req.headers.get("x-slack-signature") ?? "";

  if (!timestamp || !signature || !verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    log({ event: "interactivity.bad_signature" });
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let payload: BlockActionsPayload;
  try {
    const params = new URLSearchParams(rawBody);
    const raw = params.get("payload");
    if (!raw) return new NextResponse("Missing payload", { status: 400 });
    payload = JSON.parse(raw) as BlockActionsPayload;
  } catch {
    return new NextResponse("Malformed payload", { status: 400 });
  }

  if (payload.type !== "block_actions") {
    return new NextResponse(null, { status: 200 });
  }

  const action = payload.actions?.[0];
  if (!action || action.action_id !== "mark_solved" || !action.value) {
    return new NextResponse(null, { status: 200 });
  }

  let target: { channel: string; ts: string };
  try {
    target = JSON.parse(action.value) as { channel: string; ts: string };
    if (!target.channel || !target.ts) throw new Error("missing fields");
  } catch {
    return new NextResponse("Malformed action value", { status: 400 });
  }

  const userId = payload.user?.id ?? "unknown";

  try {
    const web = getSlackClient();
    await web.reactions.add({ channel: target.channel, timestamp: target.ts, name: "solved" });
    log({ event: "interactivity.marked_solved", channel: target.channel, ts: target.ts, by: userId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // already_reacted just means someone beat us to it — still update the reminder.
    if (!message.includes("already_reacted")) {
      logError({ event: "interactivity.reaction_failed", message });
    }
  }

  if (payload.response_url) {
    try {
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: `:white_check_mark: Løst av <@${userId}>`,
        }),
      });
    } catch (err) {
      logError({
        event: "interactivity.response_url_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return new NextResponse(null, { status: 200 });
}
