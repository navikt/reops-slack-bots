import { getToken, validateToken, parseAzureUserToken } from "@navikt/oasis";
import { log, logError } from "./log";

/**
 * Team ResearchOps' id in Team Catalog (teamkatalog.nav.no).
 * Membership is looked up live via Team Catalog instead of hardcoding
 * nav-idents. Find it via: https://teamkatalog.nav.no/team/<team-id>
 */
export const REOPS_TEAM_KATALOG_ID = "26dba481-fd96-40a8-b47d-b1ad0002bc74";

/**
 * Stable, single Team Catalog instance — Nav only has one real one
 * (teamkatalog.nav.no). The *.intern.nav.no host requires naisdevice/internnett
 * or running on the Nais cluster; unreachable from plain local dev, in which
 * case lookups fail closed.
 */
const TEAMKATALOG_BASE_URL = "https://teamkatalog-api.intern.nav.no";

const TEAM_MEMBERSHIP_CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { teams: TeamCatalogTeam[]; cachedAt: number }>();

export interface TeamCatalogTeam {
  id: string;
  name: string;
}

export interface AuthUser {
  navIdent: string;
  name: string;
  email: string | undefined;
}

export type TeamCheckResult =
  | { status: "ok"; user: AuthUser }
  | { status: "unauthenticated" }
  | { status: "forbidden"; user: AuthUser }
  | { status: "unavailable" };

function formatAzureName(name = ""): string {
  let normalized = name;
  if (normalized.includes("Ã")) {
    try {
      normalized = Buffer.from(normalized, "latin1").toString("utf-8");
    } catch {
      log({ event: "auth.name_encoding_failed" });
    }
  }
  const nameParts = normalized.split(", ");
  return nameParts.length === 2 ? `${nameParts[1]} ${nameParts[0]}` : normalized;
}

/**
 * Fetches the teams a nav-ident belongs to, from Team Catalog.
 * Team/member data is openly readable within Nav without authentication.
 * Throws on network error or non-OK response — callers must fail closed.
 */
export async function getTeamMembership(navIdent: string): Promise<TeamCatalogTeam[]> {
  const now = Date.now();

  for (const [id, entry] of cache) {
    if (now - entry.cachedAt >= TEAM_MEMBERSHIP_CACHE_TTL_MS) cache.delete(id);
  }

  const cached = cache.get(navIdent);
  if (cached) return cached.teams;

  // Note: NOT `/team-catalog/member/membership/...` — the `/team-catalog` segment
  // only exists on teamkatalog.nav.no's frontend BFF proxy path, not the real API.
  const url = `${TEAMKATALOG_BASE_URL}/member/membership/${encodeURIComponent(navIdent)}`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    logError({
      event: "teamkatalog.fetch_failed",
      navIdent,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  if (!response.ok) {
    logError({ event: "teamkatalog.non_ok", navIdent, status: response.status });
    throw new Error(`Team Catalog API returned ${response.status} for ${navIdent}`);
  }

  const data = (await response.json()) as { teams?: TeamCatalogTeam[] };
  const teams = data.teams ?? [];
  cache.set(navIdent, { teams, cachedAt: Date.now() });
  return teams;
}

/**
 * Port of innblikk-frontend's authenticateUser + requireReopsTeamMember,
 * adapted to Next.js route handlers (Request instead of Express req).
 *
 * Fail-closed: if Team Catalog is unreachable, returns "unavailable" (503)
 * rather than letting the request through.
 */
export async function requireReopsTeamMember(req: Request): Promise<TeamCheckResult> {
  try {
    const token = getToken(req);
    if (!token) {
      return { status: "unauthenticated" };
    }

    const validation = await validateToken(token);
    if (!validation.ok) {
      log({ event: "auth.invalid_token", message: validation.error?.message });
      return { status: "unauthenticated" };
    }

    const parsed = parseAzureUserToken(token);
    if (!parsed.ok) {
      logError({ event: "auth.parse_failed" });
      return { status: "unauthenticated" };
    }

    const user: AuthUser = {
      navIdent: parsed.NAVident as string,
      name: formatAzureName((parsed.name as string) || ""),
      email: parsed.preferred_username as string | undefined,
    };

    if (!user.navIdent) {
      return { status: "unauthenticated" };
    }

    const teams = await getTeamMembership(user.navIdent);
    const isMember = teams.some((t) => t.id === REOPS_TEAM_KATALOG_ID);

    if (!isMember) {
      log({
        event: "auth.not_team_member",
        navIdent: user.navIdent,
        teamIds: teams.map((t) => t.id).join(","),
      });
      return { status: "forbidden", user };
    }

    return { status: "ok", user };
  } catch (err) {
    // Fail closed: Team Catalog unreachable (or oasis threw) — deny access.
    logError({
      event: "auth.team_check_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: "unavailable" };
  }
}
