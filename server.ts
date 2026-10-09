import { runMigrations } from "./src/lib/db";
import { log, logError } from "./src/lib/log";
import { startJob, type BotJob } from "./src/lib/runner";

let started = false;

/**
 * Idempotent server startup: runs DB migrations, then registers and starts
 * all bot jobs. Called from instrumentation.ts's register() — but Next's
 * standalone build does NOT reliably invoke register(), so it is also called
 * from the root layout on first request. The `started` guard makes repeat
 * calls no-ops.
 */
export async function startServer(): Promise<void> {
  if (started) return;
  started = true;

  if (!process.env.DATABASE_URL && !process.env.NAIS_DATABASE_REOPS_SLACK_BOTS_SLACKBOTS_URL) {
    logError({ event: "server.no_database_url", message: "Bot jobs disabled (no database env)" });
    return;
  }

  log({ event: "server.migrations_start" });
  try {
    await runMigrations();
    log({ event: "server.migrations_done" });
  } catch (err) {
    // Without a migrated schema every request fails confusingly later
    // ("relation does not exist") — crash instead; K8s restarts us.
    logError({
      event: "server.migrations_failed",
      message: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }

  const jobs: BotJob[] = [
    {
      name: "unanswered-reminder",
      // Wake up hourly; the job itself applies a 1-hour grace period to new
      // messages and checks scan_window_days before re-nagging.
      intervalMs: 60 * 60 * 1000,
      run: async () => {
        const { runUnansweredReminder } = await import("./src/bots/unanswered-reminder/run");
        await runUnansweredReminder();
      },
    },
  ];

  for (const job of jobs) {
    startJob(job);
  }

  log({ event: "server.started", jobs: jobs.map((j) => j.name).join(", ") });
}
