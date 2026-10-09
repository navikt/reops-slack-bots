import { runMigrations } from "./src/lib/db";
import { log, logError } from "./src/lib/log";
import { startJob, type BotJob } from "./src/lib/runner";

/**
 * Called once at server startup via instrumentation.ts.
 * Runs DB migrations, then registers and starts all bot jobs.
 */
export async function startServer(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    logError({ event: "server.no_database_url", message: "Bot jobs disabled (DATABASE_URL not set)" });
    return;
  }

  await runMigrations();

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
