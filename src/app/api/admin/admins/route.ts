import { NextResponse } from "next/server";
import { requireAdmin, type GroupKind } from "../../../../lib/auth";
import {
  addAdminGroup,
  addAdminIdent,
  listAdminGroups,
  listAdminIdents,
  removeAdminGroup,
  removeAdminIdent,
} from "../../../../lib/db";
import { log } from "../../../../lib/log";

export const runtime = "nodejs";

const KINDS: GroupKind[] = ["team", "cluster", "productarea"];

/** GET — configured admin groups and individuals. */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }
  const [groups, idents] = await Promise.all([listAdminGroups(), listAdminIdents()]);
  return NextResponse.json({ groups, idents });
}

/** POST — grant admin access. Group: { kind, id, label }. Person: { navIdent, label? }. */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: { kind?: string; id?: string; label?: string; navIdent?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (body.navIdent) {
    await addAdminIdent(body.navIdent, body.label ?? null);
    log({ event: "admin.admin_ident_added", navIdent: body.navIdent, by: auth.user.navIdent });
    return NextResponse.json({ ok: true });
  }

  if (!body.id || !body.label || !KINDS.includes(body.kind as GroupKind)) {
    return NextResponse.json({ error: "kind, id and label — or navIdent — are required" }, { status: 400 });
  }

  await addAdminGroup(body.id, body.kind as GroupKind, body.label);
  log({ event: "admin.admin_group_added", group: `${body.kind}:${body.id}`, by: auth.user.navIdent });
  return NextResponse.json({ ok: true });
}

/** DELETE — revoke admin access. Group: { kind, id }. Person: { navIdent }. */
export async function DELETE(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  let body: { kind?: string; id?: string; navIdent?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  if (body.navIdent) {
    await removeAdminIdent(body.navIdent);
    log({ event: "admin.admin_ident_removed", navIdent: body.navIdent, by: auth.user.navIdent });
    return NextResponse.json({ ok: true });
  }

  if (!body.id || !body.kind) {
    return NextResponse.json({ error: "kind and id — or navIdent — are required" }, { status: 400 });
  }

  await removeAdminGroup(body.id, body.kind);
  log({ event: "admin.admin_group_removed", group: `${body.kind}:${body.id}`, by: auth.user.navIdent });
  return NextResponse.json({ ok: true });
}
