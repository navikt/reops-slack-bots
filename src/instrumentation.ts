/**
 * Next.js instrumentation hook — runs once when the server process starts,
 * before any requests are handled.
 *
 * MUST live in src/ (not the project root): Next's standalone build only
 * wires up register() from src/instrumentation.ts (vercel/next.js#81050).
 * Belt-and-braces: server.ts's startServer is idempotent and also called
 * from the root layout on first request, so boot works even if this hook
 * silently doesn't fire again.
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  // Only run in the Node.js runtime (not edge), and only on the server.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startServer } = await import("../server");
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "server.register_fired" }));
    startServer().catch((err) => {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "server.start_failed",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      // A half-started server that never migrated is worse than a crash —
      // K8s will restart us and the crash loop makes the failure visible.
      process.exit(1);
    });
  }
}
