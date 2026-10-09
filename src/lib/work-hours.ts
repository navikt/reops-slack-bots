/**
 * Work-hours aware grace period.
 *
 * The grace period counts *work hours*, not wall-clock hours: a message
 * posted during the evening must not become nag-worthy overnight while
 * nobody is around to answer it. Instead its grace clock starts at the next
 * work-hours opening:
 *
 *   posted inside work hours → eligible at postedAt + graceHours
 *   posted outside           → eligible at next workday 09:00 + graceHours
 *
 * Work hours: Mon–Fri, 09:00–16:30 local time (Norwegian workspace).
 *
 * Note: eligibility may land outside work hours (e.g. posted 16:00 with 1h
 * grace → due 17:00). The hourly scan delivers it then — per the requested
 * "notification outside work hours, 1 hour later" behavior.
 */

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 16;
export const WORK_END_MINUTE = 30;

function startOfWorkHours(d: Date): Date {
  const start = new Date(d);
  start.setHours(WORK_START_HOUR, 0, 0, 0);
  return start;
}

function endOfWorkHours(d: Date): Date {
  const end = new Date(d);
  end.setHours(WORK_END_HOUR, WORK_END_MINUTE, 0, 0);
  return end;
}

function isWorkday(d: Date): boolean {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

export function isWithinWorkHours(d: Date): boolean {
  return isWorkday(d) && d >= startOfWorkHours(d) && d < endOfWorkHours(d);
}

/**
 * First work-hours opening after `d`. Assumes `d` is NOT within work hours
 * (callers check isWithinWorkHours first). Before opening on a workday →
 * today 09:00; after close or on a weekend → next workday 09:00.
 */
export function nextWorkStart(d: Date): Date {
  const start = startOfWorkHours(d);
  if (isWorkday(d) && d < start) return start;
  const next = new Date(d);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isWorkday(next));
  return startOfWorkHours(next);
}

/**
 * When a Slack message becomes nag-worthy, in unix seconds (fractional,
 * matching Slack ts arithmetic). `postedTs` is the Slack message ts.
 */
export function graceEligibleTs(postedTs: string, graceHours: number): number {
  const posted = new Date(Number.parseFloat(postedTs) * 1000);
  const clockStart = isWithinWorkHours(posted) ? posted : nextWorkStart(posted);
  return (clockStart.getTime() + graceHours * 60 * 60 * 1000) / 1000;
}
