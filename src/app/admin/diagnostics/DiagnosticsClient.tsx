"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BodyShort,
  Button,
  CopyButton,
  ExpansionCard,
  Heading,
  HStack,
  InlineMessage,
  LocalAlert,
  Loader,
  Provider,
  Table,
  VStack,
} from "@navikt/ds-react";
import { en } from "@navikt/ds-react/locales";
import { type AdminState } from "../AdminClient";
import {
  DiagnosticsGrid,
  FriendlyChannel,
  FriendlyPerson,
} from "../DiagnosticsGrid";
import {
  diagnosticChannel,
  type AdminThreadCommand,
  type DiagnosticThread,
} from "../../../lib/admin-diagnostics";
import "../admin.css";

function Facts({
  caption,
  rows,
}: {
  caption: string;
  rows: Array<[string, ReactNode]>;
}) {
  return (
    <Table size="small">
      <caption className="aksel-sr-only">{caption}</caption>
      <Table.Body>
        {rows.map(([name, value]) => (
          <Table.Row key={name}>
            <Table.HeaderCell scope="row">{name}</Table.HeaderCell>
            <Table.DataCell className="tableCell">{value}</Table.DataCell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

function Copyable({ value, label }: { value: string | null; label: string }) {
  return value ? (
    <HStack gap="space-4" align="center">
      <span className="diagnosticRawValue">{value}</span>
      <CopyButton copyText={value} title={`Copy ${label}`} size="xsmall" />
    </HStack>
  ) : (
    <span>Unavailable</span>
  );
}

function DiagnosticsContent() {
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/state?view=diagnostics", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Could not load diagnostics (${res.status})`);
    setState((await res.json()) as AdminState);
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await load();
    } catch {
      setError(
        "Could not load diagnostics. Check your connection or try again.",
      );
    } finally {
      setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const act = async (
    row: DiagnosticThread,
    action: Exclude<AdminThreadCommand["action"], "inspect">,
    assignee?: string,
  ) => {
    if (!row.sourceChannel || mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    let saved = false;
    try {
      const res = await fetch("/api/admin/thread-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannelId: row.sourceChannel.id,
          threadTs: row.threadTs,
          action,
          assignee,
          expectedActionedAt: row.actionedAt,
        }),
      });
      const result = await res.json();
      if (!res.ok)
        throw new Error(
          result.detail ?? result.error ?? "Could not update thread",
        );
      saved = true;
      await load();
      setMessage(
        action === "unsuppressed"
          ? "Manual suppression removed. The next scan checks whether the thread is still open."
          : action === "released"
            ? "Assignment released. The thread can return to the channel on the next scan."
            : "Assignment updated across tracked reminders.",
      );
      return true;
    } catch (err) {
      setError(
        saved
          ? "Change saved, but diagnostics could not refresh. Use Refresh diagnostics to see the updated state."
          : err instanceof Error
            ? err.message
            : "Could not update thread",
      );
      return saved;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  return (
    <VStack gap="space-24" className="diagnosticsContent">
      <HStack justify="space-between" align="center">
        <BodyShort>
          Inspect threads and manage ownership without digging through Slack
          IDs.
        </BodyShort>
        <Button
          size="small"
          variant="secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          Refresh diagnostics
        </Button>
      </HStack>
      {error && (
        <LocalAlert status="error" as="div">
          <LocalAlert.Header>
            <LocalAlert.Title as="div">
              Diagnostics unavailable
            </LocalAlert.Title>
          </LocalAlert.Header>
          <LocalAlert.Content>{error}</LocalAlert.Content>
        </LocalAlert>
      )}
      <div role="status">
        {message && <InlineMessage status="success">{message}</InlineMessage>}
      </div>
      {!state ? (
        !error && <Loader title="Loading diagnostics" />
      ) : (
        <>
          {state.frozen && (
            <LocalAlert status="warning" as="div">
              <LocalAlert.Header>
                <LocalAlert.Title as="div">Bot paused</LocalAlert.Title>
              </LocalAlert.Header>
              <LocalAlert.Content>
                Cached diagnostics remain available, but status checks and
                thread actions require turning the bot on in settings.
              </LocalAlert.Content>
            </LocalAlert>
          )}
          <DiagnosticsGrid
            rows={state.diagnostics}
            assignees={state.assignees}
            busy={busy}
            frozen={state.frozen}
            onAction={act}
          />
          <ExpansionCard aria-label="Technical configuration" size="small">
            <ExpansionCard.Header>
              <ExpansionCard.Title as="h2" size="small">
                Technical configuration
              </ExpansionCard.Title>
              <ExpansionCard.Description>
                Your identity, effective settings and database counts.
              </ExpansionCard.Description>
            </ExpansionCard.Header>
            <ExpansionCard.Content>
              <VStack gap="space-24">
                {state.you && (
                  <section>
                    <Heading level="3" size="xsmall" spacing>
                      You
                    </Heading>
                    <Facts
                      caption="Your identity"
                      rows={[
                        [
                          "Slack name",
                          <FriendlyPerson
                            key="user"
                            person={
                              state.you.slackUserId
                                ? (state.people[state.you.slackUserId] ?? null)
                                : null
                            }
                          />,
                        ],
                        [
                          "Email",
                          <Copyable
                            key="email"
                            value={state.you.email}
                            label="email"
                          />,
                        ],
                        [
                          "Slack user ID",
                          <Copyable
                            key="slack-id"
                            value={state.you.slackUserId}
                            label="Slack user ID"
                          />,
                        ],
                        [
                          "Nav ident",
                          <HStack key="ident" gap="space-4" align="center">
                            {state.you.navIdent}
                            <CopyButton
                              copyText={state.you.navIdent}
                              size="xsmall"
                              title="Copy Nav ident"
                            />
                          </HStack>,
                        ],
                        [
                          "Replies count as team",
                          state.you.slackUserId
                            ? state.you.ignored
                              ? "Yes"
                              : "No"
                            : "Unknown — Slack account unresolved",
                        ],
                      ]}
                    />
                  </section>
                )}
                <section>
                  <Heading level="3" size="xsmall" spacing>
                    Effective settings
                  </Heading>
                  <Facts
                    caption="Effective settings"
                    rows={[
                      ["Bot", state.frozen ? "Off" : "Active"],
                      ["Scan window", `${state.scanWindowDays} days`],
                      ["Grace period", `${state.minAgeHours} hours`],
                      ["Reminder cooldown", `${state.reNagHours} hours`],
                      [
                        "Source channel ID",
                        <Copyable
                          key="source-id"
                          value={state.sourceChannelId}
                          label="source channel ID"
                        />,
                      ],
                      [
                        "Reminder channel ID",
                        <Copyable
                          key="target-id"
                          value={state.targetChannelId}
                          label="reminder channel ID"
                        />,
                      ],
                      [
                        "Work-hours awareness",
                        state.workHoursAware ? "On" : "Off",
                      ],
                      [
                        "Source channel",
                        <FriendlyChannel
                          key="source"
                          channel={
                            state.sourceChannelId
                              ? diagnosticChannel(
                                  state.sourceChannelId,
                                  state.channelIdentities,
                                )
                              : null
                          }
                        />,
                      ],
                      [
                        "Reminder channel",
                        <FriendlyChannel
                          key="target"
                          channel={
                            state.targetChannelId
                              ? diagnosticChannel(
                                  state.targetChannelId,
                                  state.channelIdentities,
                                )
                              : null
                          }
                        />,
                      ],
                    ]}
                  />
                </section>
                <section>
                  <Heading level="3" size="xsmall" spacing>
                    Database
                  </Heading>
                  <Facts
                    caption="Database row counts"
                    rows={state.tableCounts.map((entry) => [
                      entry.table,
                      entry.rows.toLocaleString("en-GB"),
                    ])}
                  />
                </section>
              </VStack>
            </ExpansionCard.Content>
          </ExpansionCard>
        </>
      )}
    </VStack>
  );
}

export function DiagnosticsClient() {
  return (
    <Provider locale={en}>
      <DiagnosticsContent />
    </Provider>
  );
}
