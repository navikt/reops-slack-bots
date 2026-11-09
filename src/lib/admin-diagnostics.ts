export interface PersonIdentity {
  id: string;
  name: string;
  email: string | null;
  resolved: boolean;
}

export interface ChannelIdentity {
  id: string;
  name: string;
  isPrivate: boolean;
  isDm: boolean;
  resolved: boolean;
}

export interface DiagnosticThread {
  id: string;
  threadTs: string;
  createdAt: string | null;
  sourceChannel: ChannelIdentity | null;
  sourceInferred: boolean;
  preview: string | null;
  author: string | null;
  permalink: string | null;
  action: "assigned" | "suppressed" | null;
  assignee: PersonIdentity | null;
  actor: PersonIdentity | null;
  actionedAt: string | null;
  lastNaggedAt: string | null;
  nextEligibleAt: string | null;
  actionChannel: ChannelIdentity | null;
  deliveries: Array<{
    channel: ChannelIdentity;
    deliveryTs: string;
    kind: string;
  }>;
}

export interface ThreadInspection {
  status: "handled" | "channel_digest" | "assignment_dm";
  checkedAt: string;
  latestActivityAt: string;
  permalink: string;
  preview: string;
}

export function slackTimestampIso(ts: string): string | null {
  if (!/^\d+\.\d{1,6}$/.test(ts)) return null;
  const date = new Date(Number(ts) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function relativeTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "Unknown time";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "Unknown time";
  const seconds = (time - now) / 1000;
  const units = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
  ] as const;
  const [divisor, unit] = units.find(([size]) => Math.abs(seconds) >= size) ?? [
    1,
    "second",
  ];
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
    Math.round(seconds / divisor),
    unit,
  );
}

export function inferThreadSource(
  candidates: string[],
  configuredSource: string | null,
): { source: string | null; inferred: boolean } {
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return { source: unique[0], inferred: false };
  if (unique.length > 1) return { source: null, inferred: false };
  return { source: configuredSource, inferred: Boolean(configuredSource) };
}

export function diagnosticPerson(
  id: string,
  people: Record<string, PersonIdentity>,
): PersonIdentity {
  return (
    people[id] ?? {
      id,
      name: id.startsWith("nav:") ? "Nav admin" : "Unknown Slack user",
      email: null,
      resolved: false,
    }
  );
}

export function diagnosticChannel(
  id: string,
  channels: Record<string, ChannelIdentity>,
): ChannelIdentity {
  return (
    channels[id] ?? {
      id,
      name: id.startsWith("D") ? "Direct message" : "Unknown channel",
      isDm: id.startsWith("D"),
      isPrivate: false,
      resolved: false,
    }
  );
}

export function buildDiagnosticThreads(input: {
  actions: Array<{
    message_ts: string;
    channel_id: string;
    action: string;
    actor_user_id: string;
    assignee_user_id: string | null;
    actioned_at: string;
  }>;
  nags: Array<{
    message_ts: string;
    channel_id: string;
    last_nagged_at: string;
  }>;
  cooldowns: Array<{
    message_ts: string;
    channel_id: string;
    next_eligible_at: string;
  }>;
  snapshots: Array<{
    sourceChannelId: string;
    threadTs: string;
    permalink: string;
    textExcerpt: string;
    authorLabel: string;
  }>;
  deliveries: Array<{
    sourceChannelId: string;
    threadTs: string;
    channelId: string;
    deliveryTs: string;
    kind: string;
  }>;
  people: Record<string, PersonIdentity>;
  channels: Record<string, ChannelIdentity>;
  configuredSource: string | null;
  permalink: (source: string, threadTs: string) => string;
}): DiagnosticThread[] {
  const ids = new Set([
    ...input.actions.map((row) => row.message_ts),
    ...input.nags.map((row) => row.message_ts),
    ...input.cooldowns.map((row) => row.message_ts),
    ...input.deliveries.map((row) => row.threadTs),
  ]);
  return [...ids]
    .map((ts): DiagnosticThread => {
      const action = input.actions.find((row) => row.message_ts === ts);
      const nag = input.nags.find((row) => row.message_ts === ts);
      const cooldown = input.cooldowns.find((row) => row.message_ts === ts);
      const snapshots = input.snapshots.filter((row) => row.threadTs === ts);
      const deliveries = input.deliveries.filter((row) => row.threadTs === ts);
      const source = inferThreadSource(
        [
          ...snapshots.map((row) => row.sourceChannelId),
          ...deliveries.map((row) => row.sourceChannelId),
        ],
        input.configuredSource,
      );
      const snapshot = snapshots.find(
        (row) => row.sourceChannelId === source.source,
      );
      return {
        id: `${source.source ?? "unknown"}:${ts}`,
        threadTs: ts,
        createdAt: slackTimestampIso(ts),
        sourceChannel: source.source
          ? diagnosticChannel(source.source, input.channels)
          : null,
        sourceInferred: source.inferred,
        preview: snapshot?.textExcerpt ?? null,
        author: snapshot?.authorLabel ?? null,
        permalink:
          snapshot?.permalink ??
          (source.source ? input.permalink(source.source, ts) : null),
        action:
          action?.action === "assigned" || action?.action === "suppressed"
            ? action.action
            : null,
        assignee: action?.assignee_user_id
          ? diagnosticPerson(action.assignee_user_id, input.people)
          : null,
        actor: action?.actor_user_id
          ? diagnosticPerson(action.actor_user_id, input.people)
          : null,
        actionedAt: action?.actioned_at ?? null,
        lastNaggedAt: nag?.last_nagged_at ?? null,
        nextEligibleAt: cooldown?.next_eligible_at ?? null,
        actionChannel: action
          ? diagnosticChannel(action.channel_id, input.channels)
          : nag
            ? diagnosticChannel(nag.channel_id, input.channels)
            : null,
        deliveries: deliveries.map((row) => ({
          channel: diagnosticChannel(row.channelId, input.channels),
          deliveryTs: row.deliveryTs,
          kind: row.kind,
        })),
      };
    })
    .sort(
      (a, b) =>
        Date.parse(b.actionedAt ?? b.lastNaggedAt ?? b.createdAt ?? "") -
        Date.parse(a.actionedAt ?? a.lastNaggedAt ?? a.createdAt ?? ""),
    )
    .slice(0, 200);
}

export type AdminThreadCommand = {
  sourceChannelId: string;
  threadTs: string;
  action: "inspect" | "unsuppressed" | "assigned" | "released";
  assignee?: string;
  expectedActionedAt?: string | null;
};

export function parseAdminThreadCommand(body: unknown): AdminThreadCommand {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid request");
  const input = body as Record<string, unknown>;
  if (
    typeof input.sourceChannelId !== "string" ||
    !/^[CG][A-Z0-9]+$/.test(input.sourceChannelId)
  )
    throw new Error("Invalid source channel");
  if (
    typeof input.threadTs !== "string" ||
    input.threadTs.length > 32 ||
    !slackTimestampIso(input.threadTs)
  )
    throw new Error("Invalid thread timestamp");
  if (
    !["inspect", "unsuppressed", "assigned", "released"].includes(
      String(input.action),
    )
  )
    throw new Error("Invalid action");
  if (
    input.action === "assigned" &&
    (typeof input.assignee !== "string" ||
      !/^[UW][A-Z0-9]+$/.test(input.assignee))
  )
    throw new Error("Select a valid assignee");
  if (
    input.action !== "inspect" &&
    input.expectedActionedAt !== null &&
    (typeof input.expectedActionedAt !== "string" ||
      !Number.isFinite(Date.parse(input.expectedActionedAt)))
  )
    throw new Error("Expected action timestamp is required");
  return {
    sourceChannelId: input.sourceChannelId,
    threadTs: input.threadTs,
    action: input.action as AdminThreadCommand["action"],
    assignee:
      input.action === "assigned" ? (input.assignee as string) : undefined,
    expectedActionedAt:
      input.action === "inspect"
        ? undefined
        : (input.expectedActionedAt as string | null),
  };
}
