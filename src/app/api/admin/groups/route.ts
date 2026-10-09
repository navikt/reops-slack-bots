import { NextResponse } from "next/server";
import {
  requireReopsTeamMember,
  searchGroups,
  type GroupKind,
} from "../../../../lib/auth";
import { addGroup, listGroups, removeGroup } from "../../../../lib/db";
import { log } from "../../../../lib/log";

export const runtime = "nodejs";

const KINDS: GroupKind[] = ["team", "cluster", "productarea"];

/** GET ?q=... searches Team Catalog groups. Without q, returns configured groups. */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ groups: [] });

  try {
    const groups = await searchGroups(q);
    return NextResponse.json({ groups });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "search failed" },
      { status: 502 },
    );
  }
}

/** POST { kind, id, label } — add a group to the ignore set. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: { kind?: string; id?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (!body.id || !body.label || !KINDS.includes(body.kind as GroupKind)) {
    return NextResponse.json({ error: "kind, id and label are required" }, { status: 400 });
  }

  await addGroup(body.id, body.kind as GroupKind, body.label);
  log({ event: "admin.group_added", group: `${body.kind}:${body.id}`, by: auth.user.navIdent });
  return NextResponse.json({ ok: true });
}

/** DELETE { kind, id } — remove a group. */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: { kind?: string; id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (!body.id || !body.kind) {
    return NextResponse.json({ error: "kind and id are required" }, { status: 400 });
  }

  await removeGroup(body.id, body.kind);
  log({ event: "admin.group_removed", group: `${body.kind}:${body.id}`, by: auth.user.navIdent });
  return NextResponse.json({ ok: true });
}
