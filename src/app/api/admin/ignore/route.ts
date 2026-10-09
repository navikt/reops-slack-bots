import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth";
import { addIgnoreEntry, removeIgnoreEntry } from "../../../../lib/db";
import { log, logError } from "../../../../lib/log";

export const runtime = "nodejs";

function authStatusToResponse(status: "forbidden" | "unavailable" | "unauthenticated"): Response {
  const code = status === "forbidden" ? 403 : status === "unavailable" ? 503 : 401;
  return NextResponse.json({ error: status }, { status: code });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") return authStatusToResponse(auth.status);

  let body: { email?: string; label?: string; navIdent?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const label = body.label?.trim() || null;
  const navIdent = body.navIdent?.trim() || null;

  try {
    const row = await addIgnoreEntry(email, label, navIdent);
    log({ event: "admin.ignore_added", email, by: auth.user.navIdent });
    return NextResponse.json({
      id: row.id,
      kind: row.kind,
      label: row.label,
      navIdent: row.nav_ident,
      email: row.email,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("unique")) {
      return NextResponse.json({ error: "Already on the list" }, { status: 409 });
    }
    logError({ event: "admin.ignore_add_failed", message });
    return NextResponse.json({ error: "Could not add to the list" }, { status: 500 });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
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
