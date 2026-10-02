import { log, logError } from "./log";

export interface BotJob {
  name: string;
  /** How often the job wakes up. The job itself decides whether to act. */
  intervalMs: number;
  run(): Promise<void>;
}

const running = new Set<string>();

export function startJob(job: BotJob): void {
  setInterval(() => {
    void runJob(job);
  }, job.intervalMs);
}

export async function runJob(job: BotJob): Promise<void> {
  if (running.has(job.name)) {
    log({ event: "job.skipped", job: job.name, reason: "already_running" });
    return;
  }
  running.add(job.name);
  const start = Date.now();
  try {
    await job.run();
    log({ event: "job.ok", job: job.name, duration_ms: Date.now() - start });
  } catch (err) {
    logError({
      event: "job.failed",
      job: job.name,
      duration_ms: Date.now() - start,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    running.delete(job.name);
  }
}
