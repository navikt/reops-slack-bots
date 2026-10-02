import { NextResponse } from "next/server";
import { requireReopsTeamMember } from "../../../../lib/auth";
import { addIgnoreEntry, removeIgnoreEntry } from "../../../../lib/db";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

function authStatusToResponse(status: "forbidden" | "unavailable" | "unauthenticated"): Response {
  const code = status === "forbidden" ? 403 : status === "unavailable" ? 503 : 401;
  return NextResponse.json({ error: status }, { status: code });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") return authStatusToResponse(auth.status);

  let body: { slackId?: string; kind?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const slackId = body.slackId?.trim();
  const kind = body.kind?.trim();
  if (!slackId || (kind !== "user" && kind !== "usergroup")) {
    return NextResponse.json(
      { error: "slackId og kind ('user' | 'usergroup') er påkrevd" },
      { status: 400 },
    );
  }
  if (kind === "user" && !slackId.startsWith("U")) {
    return NextResponse.json({ error: "Bruker-IDer starter med U (f.eks. U01234567)" }, { status: 400 });
  }
  if (kind === "usergroup" && !slackId.startsWith("S")) {
    return NextResponse.json({ error: "Brukergruppe-IDer starter med S (f.eks. S01234567)" }, { status: 400 });
  }

  const label = body.label?.trim() || null;

  try {
    const row = await addIgnoreEntry(slackId, kind, label);
    log({ event: "admin.ignore_added", slack_id: slackId, kind, by: auth.user.navIdent });
    return NextResponse.json({
      id: row.id,
      slackId: row.slack_id,
      kind: row.kind,
      label: row.label,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("unique")) {
      return NextResponse.json({ error: "Denne ID-en er allerede i ignorarlista" }, { status: 409 });
    }
    logError({ event: "admin.ignore_add_failed", message });
    return NextResponse.json({ error: "Kunne ikke legge til i ignorarlista" }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") return authStatusToResponse(auth.status);

  let body: { id?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return NextResponse.json({ error: "id (heltall) er påkrevd" }, { status: 400 });
  }

  const removed = await removeIgnoreEntry(body.id);
  if (!removed) {
    return NextResponse.json({ error: "Fant ikke raden" }, { status: 404 });
  }
  log({ event: "admin.ignore_removed", id: body.id, by: auth.user.navIdent });
  return NextResponse.json({ ok: true });
}
