import { NextResponse } from "next/server";
import { getTeamMembers, requireReopsTeamMember, type GroupKind } from "../../../../../lib/auth";

export const runtime = "nodejs";

interface TkPage<T> {
  content?: T[];
}

const TEAMKATALOG_BASE_URL = "https://teamkatalog-api.intern.nav.no";

/** GET ?kind=team|cluster|productarea&id=... → member list (name + email). */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireReopsTeamMember(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as GroupKind | null;
  const id = url.searchParams.get("id");
  if (!kind || !id || !["team", "cluster", "productarea"].includes(kind)) {
    return NextResponse.json({ error: "kind and id are required" }, { status: 400 });
  }

  try {
    let teamIds = [id];
    if (kind !== "team") {
      const param = kind === "cluster" ? "clusterId" : "productAreaId";
      const res = await fetch(
        `${TEAMKATALOG_BASE_URL}/team?${param}=${encodeURIComponent(id)}&status=ACTIVE&size=500`,
      );
      if (!res.ok) throw new Error(`child teams: ${res.status}`);
      const page = (await res.json()) as TkPage<{ id: string }>;
      teamIds = (Array.isArray(page) ? page : (page.content ?? [])).map((t) => t.id);
    }

    const lists = await Promise.all(teamIds.map(getTeamMembers));
    const seen = new Set<string>();
    const members = lists
      .flat()
      .filter((m) => {
        const key = m.email ?? m.navIdent ?? "";
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => (a.fullName ?? "").localeCompare(b.fullName ?? ""));

    return NextResponse.json({ members });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 502 },
    );
  }
}
