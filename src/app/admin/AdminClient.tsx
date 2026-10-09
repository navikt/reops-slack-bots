"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  BodyShort,
  Box,
  Button,
  ExpansionCard,
  Heading,
  HStack,
  List,
  Loader,
  Select,
  Switch,
  Table,
  VStack,
} from "@navikt/ds-react";
import { TrashIcon } from "@navikt/aksel-icons";
import { UNSAFE_Combobox as Combobox } from "@navikt/ds-react";
import "./admin.css";

interface IgnoreEntry {
  id: number;
  kind: "person";
  label: string | null;
  navIdent: string | null;
  email: string;
}

interface GroupEntry {
  id: string;
  kind: "team" | "cluster" | "productarea";
  label: string;
  memberCount: number | null;
  error: string | null;
}

interface GroupOption {
  kind: "team" | "cluster" | "productarea";
  id: string;
  label: string;
}

interface GroupMember {
  navIdent: string | null;
  email: string | null;
  fullName: string | null;
}

interface PersonHit {
  navIdent: string | null;
  fullName: string | null;
  email: string | null;
}

interface JoinedChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

interface LastScan {
  at: string;
  unsolved: number;
  nagged: number;
}

interface AdminState {
  frozen: boolean;
  scanWindowDays: number;
  minAgeHours: number;
  reNagDays: number;
  ignoreList: IgnoreEntry[];
  sourceChannelId: string | null;
  targetChannelId: string | null;
  channels: JoinedChannel[];
  channelsError: string | null;
  lastScan: LastScan | null;
  groups: GroupEntry[];
}

function GroupTableRow({
  group,
  busy,
  onRemove,
}: {
  group: GroupEntry;
  busy: boolean;
  onRemove: () => void;
}) {
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadMembers = async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/groups/members?kind=${group.kind}&id=${encodeURIComponent(group.id)}`,
      );
      if (res.ok) {
        const data = (await res.json()) as { members: GroupMember[] };
        setMembers(data.members);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Table.ExpandableRow
      togglePlacement="left"
      onOpenChange={(open) => {
        if (open && members === null) void loadMembers();
      }}
      content={
        loading || members === null ? (
          <Loader size="small" />
        ) : (
          <List size="small">
            {members.map((m) => (
              <List.Item key={m.email ?? m.navIdent}>
                {m.fullName ?? m.navIdent} {m.email ? `(${m.email})` : ""}
              </List.Item>
            ))}
          </List>
        )
      }
    >
      <Table.HeaderCell scope="row" className="tableCell">
        {group.label}
      </Table.HeaderCell>
      <Table.DataCell
        textSize="small"
        className="tableCell tableCellSubtle"
        title={
          group.kind +
          (group.memberCount !== null ? ` · ${group.memberCount} members` : "")
        }
      >
        {group.kind}
        {group.memberCount !== null
          ? ` · ${group.memberCount} members`
          : group.error
            ? " · member count unavailable"
            : ""}
      </Table.DataCell>
      <Table.DataCell align="right" className="tableCellAction">
        <Button
          variant="tertiary"
          data-color="danger"
          size="small"
          icon={<TrashIcon aria-hidden />}
          title={`Remove ${group.label}`}
          disabled={busy}
          onClick={onRemove}
        />
      </Table.DataCell>
    </Table.ExpandableRow>
  );
}

export function AdminClient() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [peopleOptions, setPeopleOptions] = useState<PersonHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState<PersonHit | null>(null);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const [groupSearching, setGroupSearching] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupOption | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/state", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(`Could not load settings (${res.status})`);
        return;
      }
      setState((await res.json()) as AdminState);
      setLoadError(null);
    } catch {
      setLoadError("Could not load settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch when the tab regains focus — covers "tab to Slack, /invite the
  // bot, tab back" without a manual reload.
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const saveSettings = async (patch: {
    frozen?: boolean;
    scanWindowDays?: number;
    minAgeHours?: number;
    reNagDays?: number;
    sourceChannelId?: string | null;
    targetChannelId?: string | null;
  }) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Save failed (${res.status})`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const searchPeople = async (query: string) => {
    if (query.trim().length < 3) {
      setPeopleOptions([]);
      return;
    }
    setSearching(true);
    try {
      const res = await fetch(
        `/api/admin/people?q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { people: PersonHit[] };
      setPeopleOptions(data.people.filter((p) => p.email));
    } finally {
      setSearching(false);
    }
  };

  const addPerson = async () => {
    if (!selectedPerson?.email) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: selectedPerson.email,
          label: selectedPerson.fullName,
          navIdent: selectedPerson.navIdent,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Could not add (${res.status})`);
        return;
      }
      setSelectedPerson(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const searchGroupsFn = async (query: string) => {
    if (query.trim().length < 3) {
      setGroupOptions([]);
      return;
    }
    setGroupSearching(true);
    try {
      const res = await fetch(
        `/api/admin/groups?q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { groups: GroupOption[] };
      setGroupOptions(data.groups);
    } finally {
      setGroupSearching(false);
    }
  };

  const addGroupFn = async () => {
    if (!selectedGroup) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selectedGroup),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Could not add group (${res.status})`);
        return;
      }
      setSelectedGroup(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeGroupFn = async (g: GroupEntry) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/groups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: g.kind, id: g.id }),
      });
      if (!res.ok) {
        setActionError(`Could not remove group (${res.status})`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeIgnore = async (id: number) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/ignore", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setActionError(`Could not remove entry (${res.status})`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runTestAction = async (action: "scan" | "ping") => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Action failed (${res.status})`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return <Alert variant="error">{loadError}</Alert>;
  }

  if (!state) {
    return (
      <HStack gap="space-8" align="center">
        <Loader size="small" />
        <span>Loading settings …</span>
      </HStack>
    );
  }

  return (
    <VStack gap="space-24" align="start">
      {actionError && <Alert variant="error">{actionError}</Alert>}

      <Box
        asChild
        background="raised"
        borderWidth="1"
        borderColor="neutral-subtle"
        borderRadius="12"
        padding="space-24"
        style={{ width: "100%" }}
      >
        <section>
          <VStack gap="space-12" align="start">
            <Heading level="2" size="medium" spacing>
              Bot on/off
            </Heading>
            <BodyShort>Off = zero Slack messages from bot.</BodyShort>
            <Switch
              checked={!state.frozen}
              disabled={busy}
              onChange={(e) => void saveSettings({ frozen: !e.target.checked })}
            >
              Bot is active
            </Switch>
            {state.frozen && (
              <Alert variant="warning">
                Bot is off. No Slack activity until turned on.
              </Alert>
            )}
          </VStack>
        </section>
      </Box>

      <Box
        asChild
        background="sunken"
        borderWidth="1"
        borderColor="neutral-subtle"
        borderRadius="12"
        padding="space-24"
        style={{ width: "100%" }}
      >
        <section>
          <VStack gap="space-20" align="start">
            <VStack gap="space-4" align="start">
              <Heading level="2" size="medium">
                Unanswered messages
              </Heading>
              <BodyShort>
                Hourly scan for messages without :solved:. Posts one digest with
                a link per message — Slack expands the links into previews.
              </BodyShort>
            </VStack>

            {/* Read-only: text straight on the gray, no card. */}
            <VStack gap="space-4" align="start">
              <Heading level="3" size="small">
                Status
              </Heading>
              <BodyShort textColor="subtle">
                {state.lastScan ? (
                  <>
                    Last check:{" "}
                    {new Date(state.lastScan.at).toLocaleString("en-GB", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                    . Found {state.lastScan.unsolved} unanswered,{" "}
                    {state.lastScan.nagged > 0
                      ? `posted a digest with ${state.lastScan.nagged}.`
                      : "posted nothing."}{" "}
                    Runs hourly.
                  </>
                ) : (
                  "No check yet. First run starts within an hour of boot."
                )}
              </BodyShort>
            </VStack>

            {/* Input sections get white cards; this title groups them. */}
            <VStack gap="space-4" align="start">
              <Heading level="3" size="small">
                Settings
              </Heading>
              <BodyShort textColor="subtle">
                When and where the scan runs.
              </BodyShort>
            </VStack>

            <Box
              asChild
              background="raised"
              borderWidth="1"
              borderColor="neutral-subtle"
              borderRadius="12"
              padding="space-24"
              style={{ width: "100%" }}
            >
              <section>
                <VStack gap="space-12" align="start">
                  <Heading level="4" size="xsmall" spacing>
                    Timing
                  </Heading>
                  <div className="fieldRow">
                    <Select
                      label="Scan window"
                      description="Ignore messages older than this."
                      value={String(state.scanWindowDays)}
                      disabled={busy}
                      onChange={(e) =>
                        void saveSettings({
                          scanWindowDays: Number(e.target.value),
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      {[1, 2, 3, 5, 7, 10, 14, 21, 30].map((d) => (
                        <option key={d} value={d}>
                          {d} {d === 1 ? "day" : "days"}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Grace period"
                      description="Wait this long before a message counts as unanswered."
                      value={String(state.minAgeHours)}
                      disabled={busy}
                      onChange={(e) =>
                        void saveSettings({
                          minAgeHours: Number(e.target.value),
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      {[0, 1, 2, 4, 8, 24].map((h) => (
                        <option key={h} value={h}>
                          {h === 0
                            ? "None"
                            : `${h} ${h === 1 ? "hour" : "hours"}`}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Re-remind after"
                      description="Cooldown before a message appears in the digest again."
                      value={String(state.reNagDays)}
                      disabled={busy}
                      onChange={(e) =>
                        void saveSettings({
                          reNagDays: Number(e.target.value),
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      {[1, 2, 3, 5, 7, 14].map((d) => (
                        <option key={d} value={d}>
                          {d} {d === 1 ? "day" : "days"}
                        </option>
                      ))}
                    </Select>
                  </div>
                </VStack>
              </section>
            </Box>

            <Box
              asChild
              background="raised"
              borderWidth="1"
              borderColor="neutral-subtle"
              borderRadius="12"
              padding="space-24"
              style={{ width: "100%" }}
            >
              <section>
                <VStack gap="space-12" align="start">
                  <Heading level="4" size="xsmall" spacing>
                    Channels
                  </Heading>
                  <BodyShort>
                    Invite @reops to a channel to list it here.
                  </BodyShort>
                  {state.channelsError && (
                    <Alert variant="warning">
                      Could not fetch channels ({state.channelsError}). Is
                      SLACK_BOT_TOKEN set?
                    </Alert>
                  )}
                  <div className="fieldRow">
                    <Select
                      label="Channel to monitor"
                      description="Checked for answers"
                      value={state.sourceChannelId ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        void saveSettings({
                          sourceChannelId: e.target.value || null,
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      <option value="">Not selected</option>
                      {state.channels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.isPrivate ? "🔒 " : "#"}
                          {ch.name}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label="Channel for reminders"
                      description="Reminders are posted here"
                      value={state.targetChannelId ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        void saveSettings({
                          targetChannelId: e.target.value || null,
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      <option value="">Not selected</option>
                      {state.channels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.isPrivate ? "🔒 " : "#"}
                          {ch.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                </VStack>
              </section>
            </Box>

            <section style={{ width: "100%" }}>
              <VStack gap="space-16" align="start" style={{ width: "100%" }}>
                <VStack gap="space-4" align="start">
                  <Heading level="3" size="small">
                    Who gets ignored
                  </Heading>
                  <BodyShort textColor="subtle">
                    Messages from these people never trigger reminders. A thread
                    counts as handled when one of them wrote the last reply.
                  </BodyShort>
                </VStack>

                <Box
                  background="raised"
                  borderWidth="1"
                  borderColor="neutral-subtle"
                  borderRadius="12"
                  padding="space-24"
                  style={{ width: "100%" }}
                  asChild
                >
                  <section aria-label="Groups">
                    <VStack
                      gap="space-12"
                      align="start"
                      style={{ width: "100%" }}
                    >
                      <Heading level="4" size="xsmall">
                        Groups
                      </Heading>
                      {state.groups.length === 0 ? (
                        <BodyShort textColor="subtle">
                          No groups yet. Add the team to cover everyone at once.
                        </BodyShort>
                      ) : (
                        <Table size="small">
                          <Table.Body>
                            {state.groups.map((g) => (
                              <GroupTableRow
                                key={`${g.kind}:${g.id}`}
                                group={g}
                                busy={busy}
                                onRemove={() => void removeGroupFn(g)}
                              />
                            ))}
                          </Table.Body>
                        </Table>
                      )}
                      {/* List and add-form are two visual groups — extra air between. */}
                      <HStack
                        gap="space-12"
                        align="end"
                        wrap
                        className="addFormRow"
                      >
                        <div style={{ width: "24rem", maxWidth: "100%" }}>
                          <Combobox
                            label="Add group"
                            description="Team, cluster or seksjon from Team Catalog. Min 3 chars."
                            options={groupOptions.map((g) => ({
                              label: `${g.label} (${g.kind})`,
                              value: `${g.kind}:${g.id}`,
                            }))}
                            filteredOptions={groupOptions.map((g) => ({
                              label: `${g.label} (${g.kind})`,
                              value: `${g.kind}:${g.id}`,
                            }))}
                            isLoading={groupSearching}
                            shouldAutocomplete={false}
                            onChange={(v) => {
                              const q =
                                v && typeof v === "object" && "target" in v
                                  ? (v as React.ChangeEvent<HTMLInputElement>)
                                      .target.value
                                  : String(v ?? "");
                              void searchGroupsFn(q);
                            }}
                            onToggleSelected={(value, selected) => {
                              if (selected) {
                                setSelectedGroup(
                                  groupOptions.find(
                                    (g) => `${g.kind}:${g.id}` === value,
                                  ) ?? null,
                                );
                              } else {
                                setSelectedGroup(null);
                              }
                            }}
                            selectedOptions={
                              selectedGroup
                                ? [
                                    {
                                      label: `${selectedGroup.label} (${selectedGroup.kind})`,
                                      value: `${selectedGroup.kind}:${selectedGroup.id}`,
                                    },
                                  ]
                                : []
                            }
                          />
                        </div>
                        <Button
                          variant="secondary"
                          disabled={busy || !selectedGroup}
                          onClick={() => void addGroupFn()}
                        >
                          Add group
                        </Button>
                      </HStack>
                    </VStack>
                  </section>
                </Box>

                <Box
                  background="raised"
                  borderWidth="1"
                  borderColor="neutral-subtle"
                  borderRadius="12"
                  padding="space-24"
                  style={{ width: "100%" }}
                  asChild
                >
                  <section aria-label="Individuals">
                    <VStack
                      gap="space-12"
                      align="start"
                      style={{ width: "100%" }}
                    >
                      <Heading level="4" size="xsmall">
                        Individuals
                      </Heading>
                      {state.ignoreList.length === 0 ? (
                        <BodyShort textColor="subtle">
                          Usually not needed when the team group covers it.
                        </BodyShort>
                      ) : (
                        <Table size="small">
                          <Table.Body>
                            {state.ignoreList.map((entry) => (
                              <Table.Row key={entry.id}>
                                {/* Empty cell aligning with the group rows' chevron column */}
                                <Table.DataCell className="tableCellAction" />
                                <Table.HeaderCell
                                  scope="row"
                                  className="tableCell"
                                >
                                  {entry.label ?? entry.email}
                                </Table.HeaderCell>
                                <Table.DataCell
                                  textSize="small"
                                  className="tableCell tableCellSubtle"
                                >
                                  {entry.label ? entry.email : ""}
                                </Table.DataCell>
                                <Table.DataCell
                                  align="right"
                                  className="tableCellAction"
                                >
                                  <Button
                                    variant="tertiary"
                                    data-color="danger"
                                    size="small"
                                    icon={<TrashIcon aria-hidden />}
                                    title={`Remove ${entry.email}`}
                                    disabled={busy}
                                    onClick={() => void removeIgnore(entry.id)}
                                  />
                                </Table.DataCell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table>
                      )}
                      {/* List and add-form are two visual groups — extra air between. */}
                      <HStack
                        gap="space-12"
                        align="end"
                        wrap
                        className="addFormRow"
                      >
                        <div style={{ width: "24rem", maxWidth: "100%" }}>
                          <Combobox
                            label="Add person"
                            description="Search by name. Matched to Slack via email."
                            options={peopleOptions.map((p) => ({
                              label: `${p.fullName ?? p.navIdent} (${p.email})`,
                              value: p.email ?? "",
                            }))}
                            filteredOptions={peopleOptions.map((p) => ({
                              label: `${p.fullName ?? p.navIdent} (${p.email})`,
                              value: p.email ?? "",
                            }))}
                            isLoading={searching}
                            shouldAutocomplete={false}
                            onChange={(e) => {
                              const v =
                                e && typeof e === "object" && "target" in e
                                  ? (e as React.ChangeEvent<HTMLInputElement>)
                                      .target.value
                                  : String(e ?? "");
                              void searchPeople(v);
                            }}
                            onToggleSelected={(value, selected) => {
                              if (selected) {
                                setSelectedPerson(
                                  peopleOptions.find(
                                    (p) => p.email === value,
                                  ) ?? null,
                                );
                              } else {
                                setSelectedPerson(null);
                              }
                            }}
                            selectedOptions={
                              selectedPerson
                                ? [
                                    {
                                      label: `${selectedPerson.fullName ?? selectedPerson.navIdent} (${selectedPerson.email})`,
                                      value: selectedPerson.email ?? "",
                                    },
                                  ]
                                : []
                            }
                          />
                        </div>
                        <Button
                          variant="secondary"
                          disabled={busy || !selectedPerson}
                          onClick={() => void addPerson()}
                        >
                          Add person
                        </Button>
                      </HStack>
                    </VStack>
                  </section>
                </Box>
              </VStack>
            </section>
            {/* Deliberately low-key: text-level expandable, not a card. */}
            <ExpansionCard aria-label="Debugging" size="small">
              <ExpansionCard.Header>
                <ExpansionCard.Title size="small">
                  Debugging
                </ExpansionCard.Title>
              </ExpansionCard.Header>
              <ExpansionCard.Content>
                <VStack gap="space-12" align="start">
                  <BodyShort textColor="subtle">
                    "Run scan now" does a real hourly scan immediately. "Post
                    test digest" sends a fake digest to the reminder channel to
                    verify wiring.
                  </BodyShort>
                  <HStack gap="space-8" wrap>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy || state.frozen}
                      onClick={() => void runTestAction("scan")}
                    >
                      Run scan now
                    </Button>
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy || state.frozen || !state.targetChannelId}
                      onClick={() => void runTestAction("ping")}
                    >
                      Post test digest
                    </Button>
                  </HStack>
                </VStack>
              </ExpansionCard.Content>
            </ExpansionCard>
          </VStack>
        </section>
      </Box>
    </VStack>
  );
}
