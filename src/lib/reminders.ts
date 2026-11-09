import { isThreadHandled } from "./thread-handled.ts";

export interface ReminderItem {
  ts: string;
  permalink: string;
  text: string;
  authorLabel: string;
  imageUrl: string | null;
}

export const MAX_REMINDER_ITEMS = 12;

export interface ScannedThread {
  ts: string;
  user: string;
  parentSolved: boolean;
  latestReplies: Array<{ user: string | null; ts: number; solved: boolean }>;
  item: ReminderItem;
}

export interface ReminderAction {
  action: string;
  assigneeUserId: string | null;
  actionedAt: Date;
}

export class ReminderConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ReminderConflictError"; }
}

export type ReminderRoute =
  | { kind: "handled" }
  | { kind: "channel_digest" }
  | { kind: "assignment_dm"; recipientUserId: string };

/** Handling precedes routing: assignment is never a substitute for resolving. */
export function routeThread(thread: ScannedThread, team: ReadonlySet<string>, action?: ReminderAction): ReminderRoute {
  if (team.has(thread.user) || isThreadHandled({
    ...thread,
    ignoredAt: action?.action === "suppressed" ? action.actionedAt.getTime() / 1000 : null,
  }, team)) return { kind: "handled" };

  const latestReplyTs = Math.max(0, ...thread.latestReplies.map((reply) => reply.ts));
  if (action?.action === "assigned" && action.assigneeUserId && action.actionedAt.getTime() / 1000 >= latestReplyTs) {
    return { kind: "assignment_dm", recipientUserId: action.assigneeUserId };
  }
  return { kind: "channel_digest" };
}

export interface ReminderDestination {
  kind: "channel_digest" | "assignment_dm";
  /** Set for channel digests; DM channel is resolved by the Slack adapter. */
  channelId?: string;
  recipientUserId: string | null;
  assignedBy?: string;
}

export interface ReminderDelivery {
  channelId: string;
  deliveryTs: string;
  sourceChannelId: string;
  threadTs: string;
  kind: ReminderDestination["kind"];
  recipientUserId: string | null;
  item: ReminderItem;
}

export interface ReminderRosterEntry {
  userId: string;
  label: string;
}

export interface ReminderStore {
  withLock<T>(run: () => Promise<T>): Promise<T>;
  listDeliveries(sourceChannelId: string): Promise<ReminderDelivery[]>;
  saveThreads(sourceChannelId: string, items: ReminderItem[]): Promise<void>;
  getThread(sourceChannelId: string, threadTs: string): Promise<ReminderItem | null>;
  recordDeliveries(deliveries: ReminderDelivery[]): Promise<void>;
  removeDeliveryItems(deliveries: ReminderDelivery[]): Promise<void>;
  pruneThreads(sourceChannelId: string, activeThreadTss: string[]): Promise<void>;
  getActions(threadTss: string[]): Promise<Map<string, ReminderAction>>;
  saveAction(threadTs: string, channelId: string, action: "suppressed" | "assigned", actor: string, assignee?: string): Promise<void>;
  release(threadTs: string): Promise<void>;
  unsuppress(threadTs: string): Promise<void>;
  recentlyNagged(threadTss: string[], hours: number): Promise<Set<string>>;
  recordNag(threadTs: string, channelId: string): Promise<void>;
}

export interface ReminderTransport {
  post(destination: ReminderDestination, items: ReminderItem[], roster: ReminderRosterEntry[]): Promise<Array<{ channelId: string; deliveryTs: string; items: ReminderItem[] }>>;
  /** False means the bot message was already deleted in Slack. */
  update(delivery: ReminderDelivery, items: ReminderItem[], roster: ReminderRosterEntry[]): Promise<boolean>;
  delete(delivery: ReminderDelivery): Promise<void>;
  fetchThread(sourceChannelId: string, threadTs: string): Promise<ReminderItem>;
  /** Only for pre-migration messages whose delivery pointers were never stored. */
  removeLegacyItem(channelId: string, deliveryTs: string, threadTs: string, blocks: unknown[]): Promise<void>;
}

function messageKey(delivery: ReminderDelivery): string {
  return JSON.stringify([delivery.channelId, delivery.deliveryTs]);
}

function destinationKey(destination: ReminderDestination): string {
  return JSON.stringify([destination.kind, destination.kind === "assignment_dm" ? destination.recipientUserId : destination.channelId]);
}

function destinationOf(delivery: ReminderDelivery): ReminderDestination {
  return { kind: delivery.kind, channelId: delivery.channelId, recipientUserId: delivery.recipientUserId };
}

function groupMessages(deliveries: ReminderDelivery[]): ReminderDelivery[][] {
  const groups = new Map<string, ReminderDelivery[]>();
  for (const delivery of deliveries) {
    const key = messageKey(delivery);
    groups.set(key, [...(groups.get(key) ?? []), delivery]);
  }
  return [...groups.values()];
}

function uniqueItems(deliveries: ReminderDelivery[]): ReminderItem[] {
  return [...new Map(deliveries.map((row) => [row.threadTs, row.item])).values()];
}

/**
 * Owns reminder state transitions and all rendered copies. Transport only
 * renders; callers don't coordinate DB writes, cleanup, or reminder cooldowns.
 */
export function createReminderManager(store: ReminderStore, transport: ReminderTransport) {
  async function replaceDestination(
    sourceChannelId: string,
    destination: ReminderDestination,
    items: ReminderItem[],
    old: ReminderDelivery[],
    roster: ReminderRosterEntry[],
  ): Promise<ReminderDelivery[]> {
    // Post + track before removing old messages. A failed post must not erase
    // the only visible reminder. Partial cleanup remains tracked for retry.
    const delivered: ReminderDelivery[] = [];
    for (let i = 0; i < items.length; i += MAX_REMINDER_ITEMS) {
      const chunk = items.slice(i, i + MAX_REMINDER_ITEMS);
      const posted = await transport.post(destination, chunk, roster);
      const rows = posted.flatMap((message) => message.items.map((item) => ({
        channelId: message.channelId,
        deliveryTs: message.deliveryTs,
        sourceChannelId,
        threadTs: item.ts,
        kind: destination.kind,
        recipientUserId: destination.recipientUserId,
        item,
      })));
      if (rows.length !== chunk.length) throw new Error("Reminder post did not deliver all items");
      // Track every successful chunk even if a later post fails.
      await store.recordDeliveries(rows);
      delivered.push(...rows);
    }
    for (const rows of groupMessages(old)) {
      await transport.delete(rows[0]);
      await store.removeDeliveryItems(rows);
    }
    return delivered;
  }

  async function removeThread(deliveries: ReminderDelivery[], threadTs: string, roster: ReminderRosterEntry[]) {
    for (const rows of groupMessages(deliveries.filter((row) => row.threadTs === threadTs))) {
      const all = deliveries.filter((row) => messageKey(row) === messageKey(rows[0]));
      const remaining = all.filter((row) => row.threadTs !== threadTs);
      if (remaining.length) {
        const exists = await transport.update(all[0], uniqueItems(remaining), roster);
        await store.removeDeliveryItems(exists ? rows : all);
      } else {
        await transport.delete(all[0]);
        await store.removeDeliveryItems(rows);
      }
    }
  }

  return {
    reconcile(input: {
      sourceChannelId: string;
      targetChannelId: string;
      threads: ScannedThread[];
      team: ReadonlySet<string>;
      roster: ReminderRosterEntry[];
      reNagHours: number;
      force?: boolean;
    }) {
      return store.withLock(async () => {
        const { sourceChannelId, threads, roster } = input;
        const actions = await store.getActions(threads.map((thread) => thread.ts));
        const recentlyNagged = input.force ? new Set<string>() : await store.recentlyNagged(threads.map((thread) => thread.ts), input.reNagHours);
        const desired = new Map<string, { destination: ReminderDestination; items: ReminderItem[] }>();
        const routes = new Map<string, string>();
        let channelOpen = 0;
        let assignedOpen = 0;
        for (const thread of threads) {
          const route = routeThread(thread, input.team, actions.get(thread.ts));
          if (route.kind === "handled") continue;
          const destination: ReminderDestination = route.kind === "assignment_dm"
            ? route
            : { kind: "channel_digest", channelId: input.targetChannelId, recipientUserId: null };
          const key = destinationKey(destination);
          const group = desired.get(key) ?? { destination, items: [] };
          group.items.push(thread.item);
          desired.set(key, group);
          routes.set(thread.ts, key);
          if (route.kind === "assignment_dm") assignedOpen += 1;
          else channelOpen += 1;
        }

        await store.saveThreads(sourceChannelId, [...desired.values()].flatMap((group) => group.items));

        const tracked = await store.listDeliveries(sourceChannelId);
        let nagged = 0;
        const replaced = new Set<string>();
        for (const [key, group] of desired) {
          const old = tracked.filter((row) => destinationKey(destinationOf(row)) === key);
          const due = group.items.filter((item) => !recentlyNagged.has(item.ts));
          // Repair delivery gaps even within cooldown (includes old untracked
          // assignments and an assignment whose immediate DM failed).
          const missingAssignment = group.destination.kind === "assignment_dm" && group.items.some((item) => !old.some((row) => row.threadTs === item.ts));
          if (due.length === 0 && !missingAssignment) continue;
          const delivered = await replaceDestination(sourceChannelId, group.destination, group.items, old, roster);
          replaced.add(key);
          for (const item of group.items) {
            // A refreshed message reminds every item it displays, not just
            // the thread that triggered the destination refresh.
            const channelId = delivered.find((row) => row.threadTs === item.ts)?.channelId;
            if (channelId) await store.recordNag(item.ts, channelId);
          }
          nagged += due.length;
        }

        for (const rows of groupMessages(tracked)) {
          const key = destinationKey(destinationOf(rows[0]));
          if (replaced.has(key)) continue;
          const remaining = rows.filter((row) => routes.get(row.threadTs) === key);
          let exists = false;
          if (remaining.length) {
            const live = desired.get(key)?.items ?? [];
            exists = await transport.update(rows[0], remaining.map((row) => live.find((item) => item.ts === row.threadTs) ?? row.item), roster);
          } else await transport.delete(rows[0]);
          await store.removeDeliveryItems(exists ? rows.filter((row) => !remaining.includes(row)) : rows);
        }
        await store.pruneThreads(sourceChannelId, [...routes.keys()]);
        return { channelOpen, assignedOpen, nagged };
      });
    },

    act(input: {
      sourceChannelId: string;
      threadTs: string;
      action: "suppressed" | "assigned" | "released" | "unsuppressed";
      actor: string;
      assignee?: string;
      /** Admin edits carry the last observed action version; Slack buttons omit it. */
      expectedActionedAt?: string | null;
      roster: ReminderRosterEntry[];
      clicked: { channelId: string; deliveryTs: string; blocks: unknown[] };
    }) {
      return store.withLock(async () => {
        const { sourceChannelId, threadTs, roster, clicked } = input;
        const current = (await store.getActions([threadTs])).get(threadTs);
        if (input.expectedActionedAt !== undefined && (current?.actionedAt.toISOString() ?? null) !== input.expectedActionedAt) {
          throw new ReminderConflictError("This thread changed. Refresh it before editing.");
        }
        const tracked = await store.listDeliveries(sourceChannelId);
        const clickedKnown = tracked.some((row) => row.channelId === clicked.channelId && row.deliveryTs === clicked.deliveryTs);
        const clickedTracked = tracked.some((row) => row.channelId === clicked.channelId && row.deliveryTs === clicked.deliveryTs && row.threadTs === threadTs);
        if (input.action === "unsuppressed") {
          if (current?.action !== "suppressed") throw new ReminderConflictError("This thread is no longer suppressed.");
          await store.unsuppress(threadTs);
          await removeThread(tracked, threadTs, roster);
        } else if (input.action === "released") {
          // A release from an old DM must not undo a newer suppression.
          if (current?.action === "assigned") await store.release(threadTs);
          await removeThread(tracked, threadTs, roster);
        } else if (input.action === "suppressed") {
          await store.saveAction(threadTs, clicked.channelId, "suppressed", input.actor);
          await removeThread(tracked, threadTs, roster);
        } else {
          if (!input.assignee) throw new Error("Assignment requires an assignee");
          const prior = current;
          if (!clickedTracked && prior?.action === "assigned" && prior.assigneeUserId === input.assignee && tracked.some((row) => row.threadTs === threadTs && row.kind === "assignment_dm" && row.recipientUserId === input.assignee)) {
            // Slack can retry a slow action after its original message has
            // already been rewritten. Do not send the same assignment twice.
            if (!clickedKnown && clicked.channelId && clicked.deliveryTs) await transport.removeLegacyItem(clicked.channelId, clicked.deliveryTs, threadTs, clicked.blocks);
            return;
          }
          const item = await store.getThread(sourceChannelId, threadTs) ?? await transport.fetchThread(sourceChannelId, threadTs);
          await store.saveThreads(sourceChannelId, [item]);
          await store.saveAction(threadTs, clicked.channelId, "assigned", input.actor, input.assignee);

          const destination: ReminderDestination = { kind: "assignment_dm", recipientUserId: input.assignee, assignedBy: input.actor };
          const oldRecipient = tracked.filter((row) => destinationKey(destinationOf(row)) === destinationKey(destination));
          const recipientActions = await store.getActions(oldRecipient.map((row) => row.threadTs));
          const stillOwned = oldRecipient.filter((row) => {
            const action = recipientActions.get(row.threadTs);
            return row.threadTs !== threadTs && action?.action === "assigned" && action.assigneeUserId === input.assignee;
          });
          const items = [...uniqueItems(stillOwned), item];
          const delivered = await replaceDestination(sourceChannelId, destination, items, oldRecipient, roster);
          // Remove the moved thread from other copies; siblings stay in place.
          await removeThread(tracked.filter((row) => !oldRecipient.includes(row)), threadTs, roster);
          const channelId = delivered.find((row) => row.threadTs === threadTs)?.channelId;
          if (channelId) await store.recordNag(threadTs, channelId);
        }
        if (!clickedKnown && clicked.channelId && clicked.deliveryTs) {
          await transport.removeLegacyItem(clicked.channelId, clicked.deliveryTs, threadTs, clicked.blocks);
        }
      });
    },
  };
}
