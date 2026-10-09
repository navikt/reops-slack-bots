export type LogFields = Record<string, string | number | boolean | null | undefined>;

const isDebug = process.env.LOG_LEVEL === "debug";

export function log(fields: { event: string } & LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/** Verbose decision-trail logging. Enable locally with LOG_LEVEL=debug. */
export function logDebug(fields: { event: string } & LogFields): void {
  if (!isDebug) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "debug", ...fields }));
}

export function logError(fields: { event: string } & LogFields): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
