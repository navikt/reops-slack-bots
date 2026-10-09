import { getToken, validateToken, parseAzureUserToken } from "@navikt/oasis";
import { log, logError } from "./log";
import { listAdminGroups, listAdminIdents } from "./db";

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

export interface TeamCatalogMember {
  navIdent: string | null;
  email: string | null;
  fullName: string | null;
}

export type GroupKind = "team" | "cluster" | "productarea";

export interface GroupOption {
  kind: GroupKind;
  id: string;
  label: string;
}

interface TkPage<T> {
  content?: T[];
}

function tkContent<T>(page: TkPage<T> | T[]): T[] {
  return Array.isArray(page) ? page : (page.content ?? []);
}

/**
 * Fetches members of a team from Team Catalog. Used to auto-derive the
 * Slack ignore list via email lookup — team membership changes propagate
 * without anyone editing the ignore list by hand.
 */
export async function getTeamMembers(teamId: string): Promise<TeamCatalogMember[]> {
  const res = await fetch(`${TEAMKATALOG_BASE_URL}/team/${encodeURIComponent(teamId)}`);
  if (!res.ok) {
    throw new Error(`Team Catalog API returned ${res.status} for team ${teamId}`);
  }
  const data = (await res.json()) as {
    members?: Array<{ resource?: { navIdent?: string; email?: string; fullName?: string } }>;
  };
  return (data.members ?? []).map((m) => ({
    navIdent: m.resource?.navIdent ?? null,
    email: m.resource?.email ?? null,
    fullName: m.resource?.fullName ?? null,
  }));
}

/** Searches active teams, clusters and product areas by name. */
export async function searchGroups(query: string): Promise<GroupOption[]> {
  const enc = encodeURIComponent(query);
  const fetcher = async (kind: GroupKind, path: string): Promise<GroupOption[]> => {
    const res = await fetch(`${TEAMKATALOG_BASE_URL}${path}${enc}?status=ACTIVE`);
    if (!res.ok) throw new Error(`Team Catalog ${path}: ${res.status}`);
    const page = (await res.json()) as TkPage<{ id: string; name: string }>;
    return tkContent(page).map((g) => ({ kind, id: g.id, label: g.name }));
  };

  const [teams, clusters, areas] = await Promise.allSettled([
    fetcher("team", "/team/search/"),
    fetcher("cluster", "/cluster/search/"),
    fetcher("productarea", "/productarea/search/"),
  ]);

  const out: GroupOption[] = [];
  if (teams.status === "fulfilled") out.push(...teams.value.slice(0, 8));
  if (clusters.status === "fulfilled") out.push(...clusters.value.slice(0, 5));
  if (areas.status === "fulfilled") out.push(...areas.value.slice(0, 5));
  return out;
}

/** Members of a cluster/productarea = own members + members of child teams. */
async function getChildTeams(kind: "cluster" | "productarea", id: string): Promise<string[]> {
  const param = kind === "cluster" ? "clusterId" : "productAreaId";
  const res = await fetch(`${TEAMKATALOG_BASE_URL}/team?${param}=${encodeURIComponent(id)}&status=ACTIVE&size=500`);
  if (!res.ok) throw new Error(`Team Catalog child teams: ${res.status}`);
  const page = (await res.json()) as TkPage<{ id: string }>;
  return tkContent(page).map((t) => t.id);
}

/** Emails of everyone in a group, recursing into child teams. */
export async function getGroupMemberEmails(kind: GroupKind, id: string): Promise<string[]> {
  const teamIds = kind === "team" ? [id] : await getChildTeams(kind, id);
  const memberLists = await Promise.all(teamIds.map(getTeamMembers));
  const emails = memberLists
    .flat()
    .map((m) => m.email)
    .filter((e): e is string => Boolean(e));
  return [...new Set(emails)];
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
 * Admin gate for /admin and /api/admin/*.
 *
 * The admin set is the union of members of the Team Catalog groups in the
 * `admin_groups` table — configured from the admin UI itself, not hardcoded.
 * Bootstrap: when no admin groups are configured yet, any logged-in Nav user
 * passes (first-come-first-served; the first visitor claims the page by
 * adding their team).
 *
 * Port of innblikk-frontend's authenticateUser + requireReopsTeamMember,
 * adapted to Next.js route handlers (Request instead of Express req).
 * Fail-closed: if Team Catalog is unreachable, returns "unavailable" (503).
 */
export async function requireAdmin(req: Request): Promise<TeamCheckResult> {
  try {
    // Local-dev escape hatch: skips Azure token + Team Catalog entirely.
    // Hard-gated on NODE_ENV so it can never fire in the deployed app.
    if (process.env.NODE_ENV !== "production" && process.env.ADMIN_DEV_BYPASS === "true") {
      return {
        status: "ok",
        user: { navIdent: "DEV", name: "Lokal utvikler", email: undefined },
      };
    }

    const token = getToken(req);
    if (!token) {
      log({ event: "auth.no_token" });
      return { status: "unauthenticated" };
    }

    const validation = await validateToken(token);
    if (!validation.ok) {
      log({ event: "auth.invalid_token", message: validation.error?.message });
      return { status: "unauthenticated" };
    }

    // oasis parseAzureUserToken hard-fails when NAVident is missing, but
    // Azure claim names have drifted before — log the payload shape so a
    // deployed "Not logged in" is debuggable from pod logs. Claims contain
    // no secrets beyond name/ident, but we log keys + types only.
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    ) as Record<string, unknown>;
    log({
      event: "auth.claims",
      keys: Object.keys(claims).sort().join(","),
      navident_type: typeof claims.NAVident,
    });

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

    const [adminGroups, adminIdents] = await Promise.all([
      listAdminGroups(),
      listAdminIdents(),
    ]);
    if (adminGroups.length === 0 && adminIdents.length === 0) {
      // Bootstrap: nobody has claimed /admin yet.
      log({ event: "auth.bootstrap_admin", navIdent: user.navIdent });
      return { status: "ok", user };
    }

    if (adminIdents.some((a) => a.nav_ident === user.navIdent)) {
      return { status: "ok", user };
    }

    const teams = await getTeamMembership(user.navIdent);
    const wanted = new Set(adminGroups.map((g) => g.id));
    const isMember = teams.some((t) => wanted.has(t.id));

    if (!isMember) {
      log({
        event: "auth.not_admin",
        navIdent: user.navIdent,
        teamIds: teams.map((t) => t.id).join(","),
      });
      return { status: "forbidden", user };
    }

    return { status: "ok", user };
  } catch (err) {
    // Fail closed: Team Catalog unreachable (or oasis threw) — deny access.
    logError({
      event: "auth.admin_check_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    return { status: "unavailable" };
  }
}
