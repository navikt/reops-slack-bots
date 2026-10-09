import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/auth";

export const runtime = "nodejs";

const TEAMKATALOG_BASE_URL = "https://teamkatalog-api.intern.nav.no";
const MAX_RESULTS = 50;

interface ResourceHit {
  navIdent?: string;
  fullName?: string;
  email?: string;
}

/**
 * People search against Team Catalog, backing the ignore-list combobox.
 * searchActive returns the full match list; we cap it client-safely.
 */
export async function GET(req: Request): Promise<Response> {
  const auth = await requireAdmin(req);
  if (auth.status !== "ok") {
    const status = auth.status === "forbidden" ? 403 : auth.status === "unavailable" ? 503 : 401;
    return NextResponse.json({ error: auth.status }, { status });
  }

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ people: [], total: 0 });

  const res = await fetch(
    `${TEAMKATALOG_BASE_URL}/resource/searchActive/${encodeURIComponent(q)}`,
  );
  if (!res.ok) {
    return NextResponse.json({ error: `Team Catalog ${res.status}` }, { status: 502 });
  }

  const page = (await res.json()) as { content?: ResourceHit[] } | ResourceHit[];
  const all = Array.isArray(page) ? page : (page.content ?? []);

  const people = all.slice(0, MAX_RESULTS).map((r) => ({
    navIdent: r.navIdent ?? null,
    fullName: r.fullName ?? null,
    email: r.email ?? null,
  }));

  return NextResponse.json({ people, total: all.length });
}
