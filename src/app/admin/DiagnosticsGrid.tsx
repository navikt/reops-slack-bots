"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BodyShort,
  ActionMenu,
  Box,
  Button,
  CopyButton,
  Heading,
  HGrid,
  HStack,
  InlineMessage,
  Link,
  Loader,
  Search,
  Select,
  Tag,
  VStack,
} from "@navikt/ds-react";
import { MenuElipsisVerticalIcon } from "@navikt/aksel-icons";
import { DataGrid } from "@navikt/ds-react/PREVIEW";
import {
  relativeTime,
  type AdminThreadCommand,
  type ChannelIdentity,
  type DiagnosticThread,
  type PersonIdentity,
  type ThreadInspection,
} from "../../lib/admin-diagnostics";

type Checked = {
  version: string | null;
  pending: boolean;
  result?: ThreadInspection;
  error?: string;
};

export function FriendlyPerson({ person }: { person: PersonIdentity | null }) {
  if (!person) return <span>—</span>;
  return (
    <HStack gap="space-4" align="center" wrap={false}>
      <span title={person.email ?? undefined}>{person.name}</span>
      {person.resolved && (
        <CopyButton
          copyText={person.email ?? person.name}
          size="xsmall"
          title={`Copy ${person.email ? "email" : "name"} for ${person.name}`}
        />
      )}
    </HStack>
  );
}

export function FriendlyChannel({
  channel,
}: {
  channel: ChannelIdentity | null;
}) {
  if (!channel) return <span>Source unknown</span>;
  const label =
    channel.resolved && !channel.isDm
      ? `${channel.isPrivate ? "🔒 " : "#"}${channel.name}`
      : channel.name;
  return (
    <HStack gap="space-4" align="center" wrap={false}>
      <span>{label}</span>
      {channel.resolved && (
        <CopyButton
          copyText={channel.name}
          size="xsmall"
          title={`Copy channel name ${channel.name}`}
        />
      )}
    </HStack>
  );
}

function ExactValue({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div>
      <dt>
        <BodyShort size="small" textColor="subtle">
          {label}
        </BodyShort>
      </dt>
      <dd style={{ margin: 0 }}>
        <HStack gap="space-4" align="center">
          <span className="diagnosticRawValue">{value ?? "—"}</span>
          {value && (
            <CopyButton
              copyText={value}
              size="xsmall"
              title={`Copy ${label.toLowerCase()}`}
            />
          )}
        </HStack>
      </dd>
    </div>
  );
}

function CheckedStatus({ checked }: { checked?: Checked }) {
  if (checked?.pending)
    return <Loader size="xsmall" title="Checking Slack thread" />;
  if (checked?.error)
    return (
      <Tag size="small" variant="outline" data-color="warning">
        Unavailable
      </Tag>
    );
  if (!checked?.result) return <span>Not checked</span>;
  const status = checked.result.status;
  return (
    <Tag
      title={`Checked at ${checked.result.checkedAt}`}
      size="small"
      variant="moderate"
      data-color={
        status === "handled"
          ? "success"
          : status === "assignment_dm"
            ? "info"
            : "warning"
      }
    >
      {status === "handled"
        ? "Handled"
        : status === "assignment_dm"
          ? "Assigned / open"
          : "Open"}
    </Tag>
  );
}

function ManualAction({ action }: { action: DiagnosticThread["action"] }) {
  return action ? (
    <Tag
      size="small"
      variant="outline"
      data-color={action === "assigned" ? "info" : "neutral"}
    >
      {action === "assigned" ? "Assigned" : "Suppressed"}
    </Tag>
  ) : (
    <span>None</span>
  );
}

export function DiagnosticsGrid({
  rows,
  assignees,
  busy,
  frozen,
  onAction,
}: {
  rows: DiagnosticThread[];
  assignees: Array<{ userId: string; label: string }>;
  busy: boolean;
  frozen: boolean;
  onAction: (
    row: DiagnosticThread,
    action: Exclude<AdminThreadCommand["action"], "inspect">,
    assignee?: string,
  ) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sorting, setSorting] = useState<DataGrid.Table.Sorting["sortOrder"]>(
    [],
  );
  const [expanded, setExpanded] = useState<string[]>([]);
  const [checked, setChecked] = useState<Record<string, Checked>>({});
  const [now, setNow] = useState(() => Date.now());
  const viewportRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(0);
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setPanelWidth(element.clientWidth),
    );
    observer.observe(element);
    setPanelWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const currentCheck = (row: DiagnosticThread) =>
    checked[row.id]?.version === row.actionedAt ? checked[row.id] : undefined;
  const check = async (row: DiagnosticThread) => {
    if (!row.sourceChannel || frozen) return;
    setChecked((state) => ({
      ...state,
      [row.id]: { version: row.actionedAt, pending: true },
    }));
    try {
      const res = await fetch("/api/admin/thread-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannelId: row.sourceChannel.id,
          threadTs: row.threadTs,
          action: "inspect",
        }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.detail ?? data.error ?? "Could not check thread");
      setChecked((state) => ({
        ...state,
        [row.id]: {
          version: row.actionedAt,
          pending: false,
          result: data as ThreadInspection,
        },
      }));
    } catch (err) {
      setChecked((state) => ({
        ...state,
        [row.id]: {
          version: row.actionedAt,
          pending: false,
          error: err instanceof Error ? err.message : "Could not check thread",
        },
      }));
    }
  };
  const act = async (
    row: DiagnosticThread,
    action: Exclude<AdminThreadCommand["action"], "inspect">,
    assignee?: string,
  ) => {
    if (await onAction(row, action, assignee))
      setChecked((state) => {
        const next = { ...state };
        delete next[row.id];
        return next;
      });
  };

  const columns: DataGrid.Columns<DiagnosticThread> = [
    {
      id: "thread",
      header: "Thread",
      isRowHeader: true,
      width: { defaultValue: 300 },
      bodyCell: (row) => (
        <VStack gap="space-4">
          {row.permalink ? (
            <Link href={row.permalink} target="_blank" rel="noreferrer">
              {row.preview
                ? `${row.preview.slice(0, 90)}${row.preview.length > 90 ? "…" : ""}`
                : "Open Slack thread"}
            </Link>
          ) : (
            <span>Thread source unavailable</span>
          )}
          {row.author && (
            <BodyShort size="small" textColor="subtle">
              {row.author}
            </BodyShort>
          )}
        </VStack>
      ),
    },
    {
      id: "age",
      header: "Thread age",
      isSortable: true,
      width: { defaultValue: 150 },
      bodyCell: (row) => (
        <time
          dateTime={row.createdAt ?? undefined}
          title={row.createdAt ?? undefined}
        >
          {relativeTime(row.createdAt, now)}
        </time>
      ),
    },
    {
      id: "channel",
      header: "Source channel",
      isSortable: true,
      width: { defaultValue: 200 },
      bodyCell: (row) => <FriendlyChannel channel={row.sourceChannel} />,
    },
    {
      id: "action",
      header: "Saved action",
      isSortable: true,
      width: { defaultValue: 140 },
      bodyCell: (row) => <ManualAction action={row.action} />,
    },
    {
      id: "assignee",
      header: "Assignee",
      isSortable: true,
      width: { defaultValue: 220 },
      bodyCell: (row) => <FriendlyPerson person={row.assignee} />,
    },
    {
      id: "actor",
      header: "By",
      isSortable: true,
      width: { defaultValue: 200 },
      bodyCell: (row) => <FriendlyPerson person={row.actor} />,
    },
    {
      id: "status",
      header: "Checked Slack status",
      width: { defaultValue: 160 },
      bodyCell: (row) => <CheckedStatus checked={currentCheck(row)} />,
    },
    {
      id: "cooldown",
      header: "Next reminder eligible",
      isSortable: true,
      width: { defaultValue: 180 },
      bodyCell: (row) =>
        row.nextEligibleAt ? (
          <time dateTime={row.nextEligibleAt} title={row.nextEligibleAt}>
            {relativeTime(row.nextEligibleAt, now)}
          </time>
        ) : (
          <span>No active cooldown</span>
        ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "right",
      width: { defaultValue: 140 },
      bodyCell: (row) => (
        <ActionMenu>
          <ActionMenu.Trigger>
            <Button
              type="button"
              size="xsmall"
              variant="tertiary"
              disabled={busy || frozen || !row.sourceChannel}
              icon={<MenuElipsisVerticalIcon aria-hidden />}
              aria-label={`Actions for ${row.preview?.slice(0, 60) ?? "Slack thread"}`}
            >
              Actions
            </Button>
          </ActionMenu.Trigger>
          <ActionMenu.Content align="end">
            <ActionMenu.Item onSelect={() => void check(row)}>
              Check Slack status
            </ActionMenu.Item>
            {row.action === "suppressed" && (
              <ActionMenu.Item onSelect={() => void act(row, "unsuppressed")}>
                Unsuppress
              </ActionMenu.Item>
            )}
            {row.action === "assigned" && (
              <ActionMenu.Item onSelect={() => void act(row, "released")}>
                Release to channel
              </ActionMenu.Item>
            )}
            {row.action !== "suppressed" && assignees.length > 0 && (
              <ActionMenu.Sub>
                <ActionMenu.SubTrigger>
                  {row.action === "assigned" ? "Reassign to" : "Assign to"}
                </ActionMenu.SubTrigger>
                <ActionMenu.SubContent>
                  {assignees.map((entry) => (
                    <ActionMenu.Item
                      key={entry.userId}
                      disabled={entry.userId === row.assignee?.id}
                      onSelect={() => void act(row, "assigned", entry.userId)}
                    >
                      {entry.label}
                      {entry.userId === row.assignee?.id ? " (current)" : ""}
                    </ActionMenu.Item>
                  ))}
                </ActionMenu.SubContent>
              </ActionMenu.Sub>
            )}
          </ActionMenu.Content>
        </ActionMenu>
      ),
    },
  ];
  // Stretch the last data column so Aksel's trailing filler cannot leave the
  // sticky Actions column floating away from the right edge on wide screens.
  const fixedWidth = columns.reduce(
    (sum, column) =>
      sum +
      (column.id !== "cooldown" &&
      typeof column.width?.defaultValue === "number"
        ? column.width.defaultValue
        : 0),
    52,
  );
  const fittedColumns = columns.map((column) =>
    column.id === "cooldown"
      ? { ...column, width: { value: Math.max(180, panelWidth - fixedWidth) } }
      : column,
  );
  const data = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter(
      (row) =>
        (filter === "all" ||
          row.action === filter ||
          (filter === "cooldown" && Boolean(row.nextEligibleAt))) &&
        (!q ||
          [
            row.preview,
            row.author,
            row.sourceChannel?.name,
            row.assignee?.name,
            row.assignee?.email,
            row.actor?.name,
            row.threadTs,
          ].some((value) => value?.toLowerCase().includes(q))),
    );
    const value = (row: DiagnosticThread, id: string): string | number => {
      switch (id) {
        case "age":
          return Date.parse(row.createdAt ?? "") || 0;
        case "channel":
          return row.sourceChannel?.name ?? "";
        case "assignee":
          return row.assignee?.name ?? "";
        case "actor":
          return row.actor?.name ?? "";
        case "action":
          return row.action ?? "";
        case "cooldown":
          return Date.parse(row.nextEligibleAt ?? "") || 0;
        default:
          return "";
      }
    };
    return filtered.toSorted((a, b) => {
      for (const order of sorting ?? []) {
        const left = value(a, order.columnId),
          right = value(b, order.columnId);
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        if (comparison)
          return order.direction === "asc" ? comparison : -comparison;
      }
      return 0;
    });
  }, [rows, query, filter, sorting]);

  return (
    <VStack gap="space-16" style={{ width: "100%" }}>
      <Heading level="2" size="small">
        Threads
      </Heading>
      <BodyShort size="small" textColor="subtle">
        Recent threads, up to 200. Age is since the original message, not the
        latest reply. Expand a row to check Slack status, see internal IDs, or
        change ownership. Manual actions are not proof that a thread is still
        handled.
      </BodyShort>
      <HGrid columns={{ xs: 1, md: "2fr 1fr" }} gap="space-16" align="end">
        <Search
          label="Search threads"
          hideLabel={false}
          value={query}
          onChange={setQuery}
          onClear={() => setQuery("")}
        />
        <Select
          label="Show threads"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">All threads</option>
          <option value="assigned">Assigned</option>
          <option value="suppressed">Suppressed</option>
          <option value="cooldown">In reminder cooldown</option>
        </Select>
      </HGrid>
      {data.length > 0 && (
        <BodyShort size="small" textColor="subtle">
          Scroll the table horizontally for additional columns. Actions stay
          pinned on the right.
        </BodyShort>
      )}
      <div ref={viewportRef} className="diagnosticsGridViewport">
        {data.length === 0 ? (
          <Box
            padding="space-24"
            borderWidth="1"
            borderColor="neutral-subtle"
            borderRadius="8"
          >
            <BodyShort role="status">No threads match this view.</BodyShort>
          </Box>
        ) : (
          <DataGrid
            columns={fittedColumns}
            data={data}
            getRowId={(row) => row.id}
            isLoading={busy}
            defaultSettings={{
              rowDensity: "standard",
              textSize: "small",
              truncateContent: false,
              stickyColumns: { end: 1 },
            }}
            style={{ width: "100%" }}
          >
            <DataGrid.Table<DiagnosticThread>
              aria-label="Thread diagnostics"
              layout="fixed"
              stickyHeader={false}
              emptyContent={
                <div
                  className="diagnosticPanel"
                  style={{
                    maxWidth: panelWidth || "100%",
                    textAlign: "center",
                  }}
                >
                  <BodyShort>No threads match this view.</BodyShort>
                </div>
              }
              loadingContent={{
                variant: "overlay",
                label: "Updating diagnostics",
              }}
              sorting={{
                allowMultiSort: true,
                sortOrder: sorting,
                onSortOrderChange: setSorting,
              }}
              detailsPanel={{
                expandedRowIds: expanded,
                onExpandedRowIdsChange: (ids) => {
                  setExpanded(ids);
                  for (const id of ids.filter((id) => !expanded.includes(id))) {
                    const row = rows.find((entry) => entry.id === id);
                    if (row && !currentCheck(row)) void check(row);
                  }
                },
                getContent: (row) => (
                  <Box
                    padding="space-16"
                    className="diagnosticPanel"
                    style={{ maxWidth: panelWidth || "100%" }}
                  >
                    <VStack gap="space-16">
                      <Heading level="3" size="xsmall">
                        Thread details
                      </Heading>
                      {row.sourceInferred && (
                        <BodyShort size="small">
                          Source inferred from the current bot configuration;
                          checking Slack verifies that the thread exists there.
                        </BodyShort>
                      )}
                      <HStack gap="space-12" align="center">
                        <CheckedStatus checked={currentCheck(row)} />
                        <Button
                          type="button"
                          size="xsmall"
                          variant="secondary"
                          disabled={
                            frozen ||
                            !row.sourceChannel ||
                            currentCheck(row)?.pending
                          }
                          onClick={() => void check(row)}
                        >
                          Refresh Slack status
                        </Button>
                        {currentCheck(row)?.result && (
                          <BodyShort size="small">
                            Checked{" "}
                            {relativeTime(
                              currentCheck(row)!.result!.checkedAt,
                              now,
                            )}{" "}
                            · latest activity{" "}
                            {relativeTime(
                              currentCheck(row)!.result!.latestActivityAt,
                              now,
                            )}
                          </BodyShort>
                        )}
                      </HStack>
                      {currentCheck(row)?.error && (
                        <InlineMessage status="error" role="alert" size="small">
                          {currentCheck(row)?.error}
                        </InlineMessage>
                      )}
                      {frozen && (
                        <BodyShort size="small">
                          Bot is off. Status checks and thread actions are
                          paused.
                        </BodyShort>
                      )}
                      <BodyShort size="small" textColor="subtle">
                        Unsuppress removes only the manual mark and cooldown.
                        The thread returns on the next scan only if it is still
                        open.
                      </BodyShort>
                      <dl className="diagnosticDetails">
                        <ExactValue
                          label="Thread timestamp"
                          value={row.threadTs}
                        />
                        <ExactValue
                          label="Created (ISO 8601)"
                          value={row.createdAt}
                        />
                        <ExactValue
                          label="Source channel ID"
                          value={row.sourceChannel?.id}
                        />
                        <ExactValue
                          label="Assignee Slack ID"
                          value={row.assignee?.id}
                        />
                        <ExactValue
                          label="Assignee email"
                          value={row.assignee?.email}
                        />
                        <ExactValue label="Actor ID" value={row.actor?.id} />
                        <ExactValue
                          label="Actor email"
                          value={row.actor?.email}
                        />
                        <ExactValue
                          label="Action channel ID"
                          value={row.actionChannel?.id}
                        />
                        <ExactValue
                          label="Action time (ISO 8601)"
                          value={row.actionedAt}
                        />
                        <ExactValue
                          label="Last reminded (ISO 8601)"
                          value={row.lastNaggedAt}
                        />
                        <ExactValue
                          label="Next eligible (ISO 8601)"
                          value={row.nextEligibleAt}
                        />
                        <ExactValue
                          label="Slack thread link"
                          value={row.permalink}
                        />
                      </dl>
                      {row.deliveries.length > 0 && (
                        <VStack gap="space-8">
                          <Heading level="3" size="xsmall">
                            Tracked deliveries
                          </Heading>
                          {row.deliveries.map((delivery) => (
                            <HStack
                              key={`${delivery.channel.id}:${delivery.deliveryTs}`}
                              gap="space-12"
                              align="center"
                            >
                              <FriendlyChannel channel={delivery.channel} />
                              <span>
                                {delivery.kind === "assignment_dm"
                                  ? "Assignment DM"
                                  : "Channel digest"}
                              </span>
                              <CopyButton
                                copyText={delivery.channel.id}
                                size="xsmall"
                                title="Copy delivery channel ID"
                              />
                              <span className="diagnosticRawValue">
                                {delivery.deliveryTs}
                              </span>
                              <CopyButton
                                copyText={delivery.deliveryTs}
                                size="xsmall"
                                title="Copy delivery timestamp"
                              />
                            </HStack>
                          ))}
                        </VStack>
                      )}
                    </VStack>
                  </Box>
                ),
              }}
            />
          </DataGrid>
        )}
      </div>
    </VStack>
  );
}
