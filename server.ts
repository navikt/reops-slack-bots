import { runMigrations, seedResearchopsUsergroup } from "./src/lib/db";
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

  const usergroupId = process.env.SLACK_RESEARCHOPS_USERGROUP_ID;
  if (usergroupId) {
    await seedResearchopsUsergroup(usergroupId);
  } else {
    log({ event: "server.no_usergroup_seed", message: "SLACK_RESEARCHOPS_USERGROUP_ID not set" });
  }

  const jobs: BotJob[] = [
    {
      name: "unanswered-reminder",
      // Wake up every 3 hours; the job itself checks nag_frequency_days from
      // the settings table to decide whether re-nagging is due.
      intervalMs: 3 * 60 * 60 * 1000,
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
