import { NextResponse, type NextRequest } from "next/server";

/**
 * Host-based router for the two-ingress split (see .nais/prod.yaml):
 *
 *  - reops.ansatt.nav.no       — admin UI + admin API. Platform-level SSO in
 *                                front; Wonderwall injects the user token.
 *  - reops-slack-bots.nav.no   — public internet, exists ONLY for Slack
 *                                webhooks under /api/slack/*. Everything
 *                                else on this host 404s.
 *
 * Each route under /api/slack/* does its own HMAC-SHA256 signature
 * verification, so the only thing this middleware adds is a hard guarantee
 * that no other route (/, /admin, /api/admin/*, …) is reachable from the
 * public internet, even if a future ingress rule accidentally widens the
 * path scope.
 */
const PUBLIC_HOST = "reops-slack-bots.nav.no";
const PUBLIC_PREFIX = "/api/slack";

export function middleware(req: NextRequest): Response | undefined {
  const host = req.headers.get("host")?.split(":")[0] ?? "";
  if (host !== PUBLIC_HOST) return undefined; // ansatt ingress — let through
  const path = req.nextUrl.pathname;
  if (path === PUBLIC_PREFIX || path.startsWith(`${PUBLIC_PREFIX}/`)) {
    return undefined;
  }
  return new NextResponse(null, { status: 404 });
}

// Run on everything; the early-returns above make non-public hosts a no-op.
export const config = {
  matcher: "/:path*",
};
