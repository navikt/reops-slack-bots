export type LogFields = Record<string, string | number | boolean | null | undefined>;

export function log(fields: { event: string } & LogFields): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

export function logError(fields: { event: string } & LogFields): void {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}
