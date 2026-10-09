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

interface AdminIdentEntry {
  nav_ident: string;
  label: string | null;
}

interface AdminState {
  frozen: boolean;
  scanWindowDays: number;
  minAgeHours: number;
  reNagHours: number;
  ignoreList: IgnoreEntry[];
  sourceChannelId: string | null;
  targetChannelId: string | null;
  channels: JoinedChannel[];
  channelsError: string | null;
  lastScan: LastScan | null;
  groups: GroupEntry[];
  adminGroups: GroupEntry[];
  adminIdents: AdminIdentEntry[];
  adminBootstrap: boolean;
}

/** Re-remind cooldown choices, in hours (0.5 = 30 minutes). */
const RE_NAG_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 0.5, label: "30 minutes" },
  { hours: 1, label: "1 hour" },
  { hours: 2, label: "2 hours" },
  { hours: 3, label: "3 hours" },
  { hours: 24, label: "1 day" },
  { hours: 48, label: "2 days" },
  { hours: 72, label: "3 days" },
  { hours: 120, label: "5 days" },
  { hours: 168, label: "7 days" },
  { hours: 336, label: "14 days" },
];

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
          onClick={onRemove}
        />
      </Table.DataCell>
    </Table.ExpandableRow>
  );
}

/** Card listing Team Catalog groups with a combobox to add more. Shared by
 * ignore-groups and admin-groups. */
function GroupManager({
  title,
  description,
  emptyText,
  groups,
  busy,
  options,
  searching,
  selected,
  onSearch,
  onSelect,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  emptyText: string;
  groups: GroupEntry[];
  busy: boolean;
  options: GroupOption[];
  searching: boolean;
  selected: GroupOption | null;
  onSearch: (q: string) => void;
  onSelect: (g: GroupOption | null) => void;
  onAdd: () => void;
  onRemove: (g: GroupEntry) => void;
}) {
  return (
    <Box
      background="raised"
      borderWidth="1"
      borderColor="neutral-subtle"
      borderRadius="12"
      padding="space-24"
      style={{ width: "100%" }}
      asChild
    >
      <section aria-label={title}>
        <VStack gap="space-12" align="start" style={{ width: "100%" }}>
          <Heading level="4" size="xsmall">
            {title}
          </Heading>
          <BodyShort textColor="subtle">{description}</BodyShort>
          {groups.length === 0 ? (
            <BodyShort textColor="subtle">{emptyText}</BodyShort>
          ) : (
            <Table size="small">
              <Table.Body>
                {groups.map((g) => (
                  <GroupTableRow
                    key={`${g.kind}:${g.id}`}
                    group={g}
                    busy={busy}
                    onRemove={() => onRemove(g)}
                  />
                ))}
              </Table.Body>
            </Table>
          )}
          {/* List and add-form are two visual groups — extra air between. */}
          <HStack gap="space-12" align="end" wrap className="addFormRow">
            <div style={{ width: "24rem", maxWidth: "100%" }}>
              <Combobox
                label="Add group"
                description="Team, cluster or seksjon from Team Catalog. Min 3 chars."
                options={options.map((g) => ({
                  label: `${g.label} (${g.kind})`,
                  value: `${g.kind}:${g.id}`,
                }))}
                filteredOptions={options.map((g) => ({
                  label: `${g.label} (${g.kind})`,
                  value: `${g.kind}:${g.id}`,
                }))}
                isLoading={searching}
                shouldAutocomplete={false}
                onChange={(v) => {
                  const q =
                    v && typeof v === "object" && "target" in v
                      ? (v as React.ChangeEvent<HTMLInputElement>).target.value
                      : String(v ?? "");
                  onSearch(q);
                }}
                onToggleSelected={(value, isSelected) => {
                  onSelect(
                    isSelected
                      ? (options.find((g) => `${g.kind}:${g.id}` === value) ?? null)
                      : null,
                  );
                }}
                selectedOptions={
                  selected
                    ? [
                        {
                          label: `${selected.label} (${selected.kind})`,
                          value: `${selected.kind}:${selected.id}`,
                        },
                      ]
                    : []
                }
              />
            </div>
            {/* No disabled state (contrast/a11y): button appears when usable. */}
            {!busy && selected && (
              <Button variant="secondary" onClick={onAdd}>
                Add
              </Button>
            )}
          </HStack>
        </VStack>
      </section>
    </Box>
  );
}

/** Card listing people with a combobox to add more. Shared by the ignore
 * list (matched to Slack via email) and admin individuals (navIdent). */
function PersonManager<T extends { label: string | null }>({
  title,
  description,
  emptyText,
  people,
  busy,
  options,
  searching,
  selected,
  optionLabel,
  optionValue,
  rowTitle,
  rowSub,
  rowKey,
  onSearch,
  onSelect,
  onAdd,
  onRemove,
}: {
  title: string;
  description: string;
  emptyText: string;
  people: T[];
  busy: boolean;
  options: PersonHit[];
  searching: boolean;
  selected: PersonHit | null;
  optionLabel: (p: PersonHit) => string;
  optionValue: (p: PersonHit) => string;
  rowTitle: (p: T) => string;
  rowSub: (p: T) => string;
  rowKey: (p: T) => string;
  onSearch: (q: string) => void;
  onSelect: (p: PersonHit | null) => void;
  onAdd: () => void;
  onRemove: (p: T) => void;
}) {
  return (
    <Box
      background="raised"
      borderWidth="1"
      borderColor="neutral-subtle"
      borderRadius="12"
      padding="space-24"
      style={{ width: "100%" }}
      asChild
    >
      <section aria-label={title}>
        <VStack gap="space-12" align="start" style={{ width: "100%" }}>
          <Heading level="4" size="xsmall">
            {title}
          </Heading>
          <BodyShort textColor="subtle">{description}</BodyShort>
          {people.length === 0 ? (
            <BodyShort textColor="subtle">{emptyText}</BodyShort>
          ) : (
            <Table size="small">
              <Table.Body>
                {people.map((p) => (
                  <Table.Row key={rowKey(p)}>
                    {/* Empty cell aligning with the group rows' chevron column */}
                    <Table.DataCell className="tableCellAction" />
                    <Table.HeaderCell scope="row" className="tableCell">
                      {rowTitle(p)}
                    </Table.HeaderCell>
                    <Table.DataCell
                      textSize="small"
                      className="tableCell tableCellSubtle"
                    >
                      {rowSub(p)}
                    </Table.DataCell>
                    <Table.DataCell align="right" className="tableCellAction">
                      <Button
                        variant="tertiary"
                        data-color="danger"
                        size="small"
                        icon={<TrashIcon aria-hidden />}
                        title={`Remove ${rowTitle(p)}`}
                        onClick={() => onRemove(p)}
                      />
                    </Table.DataCell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
          {/* List and add-form are two visual groups — extra air between. */}
          <HStack gap="space-12" align="end" wrap className="addFormRow">
            <div style={{ width: "24rem", maxWidth: "100%" }}>
              <Combobox
                label="Add person"
                description={description}
                options={options.map((p) => ({
                  label: optionLabel(p),
                  value: optionValue(p),
                }))}
                filteredOptions={options.map((p) => ({
                  label: optionLabel(p),
                  value: optionValue(p),
                }))}
                isLoading={searching}
                shouldAutocomplete={false}
                onChange={(e) => {
                  const v =
                    e && typeof e === "object" && "target" in e
                      ? (e as React.ChangeEvent<HTMLInputElement>).target.value
                      : String(e ?? "");
                  onSearch(v);
                }}
                onToggleSelected={(value, isSelected) => {
                  onSelect(
                    isSelected
                      ? (options.find((p) => optionValue(p) === value) ?? null)
                      : null,
                  );
                }}
                selectedOptions={
                  selected
                    ? [{ label: optionLabel(selected), value: optionValue(selected) }]
                    : []
                }
              />
            </div>
            {/* No disabled state (contrast/a11y): appears when usable. */}
            {!busy && selected && (
              <Button variant="secondary" onClick={onAdd}>
                Add
              </Button>
            )}
          </HStack>
        </VStack>
      </section>
    </Box>
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
  const [adminGroupOptions, setAdminGroupOptions] = useState<GroupOption[]>([]);
  const [adminGroupSearching, setAdminGroupSearching] = useState(false);
  const [selectedAdminGroup, setSelectedAdminGroup] = useState<GroupOption | null>(null);
  const [adminPeopleOptions, setAdminPeopleOptions] = useState<PersonHit[]>([]);
  const [adminPeopleSearching, setAdminPeopleSearching] = useState(false);
  const [selectedAdminPerson, setSelectedAdminPerson] = useState<PersonHit | null>(null);

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
  // bot, tab back" without a manual reload. Track real backgrounding via
  // visibilitychange and throttle: dev-server HMR rebuilds fire spurious
  // focus events in a loop (page never hidden), which otherwise turns this
  // into an infinite refetch storm on first boot.
  useEffect(() => {
    let wasHidden = false;
    let lastFetch = 0;
    const onVisibility = () => {
      wasHidden = document.hidden;
    };
    const onFocus = () => {
      const now = Date.now();
      if (!wasHidden || now - lastFetch < 5000) return;
      lastFetch = now;
      wasHidden = false;
      void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const saveSettings = async (patch: {
    frozen?: boolean;
    scanWindowDays?: number;
    minAgeHours?: number;
    reNagHours?: number;
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

  // Debounced + aborted people search (see makeGroupSearch for why).
  // Search results need an email for the ignore list (Slack matching);
  // admin-person search keeps everyone (navIdent is enough).
  const makePeopleSearch = (
    setOptions: (o: PersonHit[]) => void,
    setSearchingFlag: (b: boolean) => void,
    requireEmail: boolean,
  ) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    return (query: string) => {
      if (timer) clearTimeout(timer);
      const q = query.trim();
      if (q.length < 3) {
        inFlight?.abort();
        setOptions([]);
        setSearchingFlag(false);
        return;
      }
      setSearchingFlag(true);
      timer = setTimeout(() => {
        inFlight?.abort();
        inFlight = new AbortController();
        void fetch(`/api/admin/people?q=${encodeURIComponent(q)}`, {
          signal: inFlight.signal,
        })
          .then(async (res) => {
            if (!res.ok) return;
            const data = (await res.json()) as { people: PersonHit[] };
            setOptions(
              requireEmail ? data.people.filter((p) => p.email) : data.people,
            );
          })
          .catch(() => undefined)
          .finally(() => setSearchingFlag(false));
      }, 350);
    };
  };

  const searchPeople = makePeopleSearch(setPeopleOptions, setSearching, true);
  // Admin people are matched by navIdent — no email required.
  const searchAdminPeople = makePeopleSearch(setAdminPeopleOptions, setAdminPeopleSearching, false);

  const addPerson = async () => {
    const person = selectedPerson;
    if (!person?.email) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: person.email,
          label: person.fullName,
          navIdent: person.navIdent,
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

  // Group search is shared by ignore-groups and admin-groups (same Team
  // Catalog endpoint); only the target state differs. Debounced + aborted:
  // Team Catalog round-trips take seconds, so one fetch per keystroke piles
  // up into a stale-response storm.
  const makeGroupSearch =
    (
      setOptions: (o: GroupOption[]) => void,
      setSearchingFlag: (b: boolean) => void,
    ) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let inFlight: AbortController | null = null;
      return (query: string) => {
        if (timer) clearTimeout(timer);
        const q = query.trim();
        if (q.length < 3) {
          inFlight?.abort();
          setOptions([]);
          setSearchingFlag(false);
          return;
        }
        setSearchingFlag(true);
        timer = setTimeout(() => {
          inFlight?.abort();
          inFlight = new AbortController();
          void fetch(`/api/admin/groups?q=${encodeURIComponent(q)}`, {
            signal: inFlight.signal,
          })
            .then(async (res) => {
              if (!res.ok) return;
              const data = (await res.json()) as { groups: GroupOption[] };
              setOptions(data.groups);
            })
            .catch(() => undefined) // aborted or network error — ignore
            .finally(() => setSearchingFlag(false));
        }, 350);
      };
    };

  const searchGroupsFn = makeGroupSearch(setGroupOptions, setGroupSearching);
  const searchAdminGroupsFn = makeGroupSearch(setAdminGroupOptions, setAdminGroupSearching);

  const addGroupTo = async (
    endpoint: string,
    group: GroupOption,
    clear: () => void,
  ) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(group),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Could not add group (${res.status})`);
        return;
      }
      clear();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeGroupFrom = async (endpoint: string, g: GroupEntry) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(endpoint, {
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

  const addAdminPerson = async () => {
    const person = selectedAdminPerson;
    if (!person?.navIdent) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ navIdent: person.navIdent, label: person.fullName }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setActionError(data?.error ?? `Could not add (${res.status})`);
        return;
      }
      setSelectedAdminPerson(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeAdminPerson = async (navIdent: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ navIdent }),
      });
      if (!res.ok) {
        setActionError(`Could not remove (${res.status})`);
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
            <BodyShort>
              If the bot is disabled, it prevents Slack messages from being sent
              by the bot.
            </BodyShort>
            <Switch
              checked={!state.frozen}
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
                      description="Work hours (Mon–Fri 09–16:30) before a message counts as unanswered. Evening posts wait until next morning."
                      value={String(state.minAgeHours)}
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
                      value={String(state.reNagHours)}
                      onChange={(e) =>
                        void saveSettings({
                          reNagHours: Number(e.target.value),
                        })
                      }
                      style={{ width: "100%" }}
                    >
                      {RE_NAG_OPTIONS.map((o) => (
                        <option key={o.hours} value={o.hours}>
                          {o.label}
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
                    counts as handled when one of them wrote the last reply — or
                    when the newest :solved: is more recent than the last
                    follow-up.
                  </BodyShort>
                </VStack>

                <GroupManager
                  title="Groups"
                  description="Members of these groups count as team."
                  emptyText="No groups yet. Add the team to cover everyone at once."
                  groups={state.groups}
                  busy={busy}
                  options={groupOptions}
                  searching={groupSearching}
                  selected={selectedGroup}
                  onSearch={(q) => void searchGroupsFn(q)}
                  onSelect={setSelectedGroup}
                  onAdd={() => {
                    if (selectedGroup) {
                      void addGroupTo("/api/admin/groups", selectedGroup, () =>
                        setSelectedGroup(null),
                      );
                    }
                  }}
                  onRemove={(g) => void removeGroupFrom("/api/admin/groups", g)}
                />

                <PersonManager
                  title="Individuals"
                  description="Search by name. Matched to Slack via email."
                  emptyText="Usually not needed when the team group covers it."
                  people={state.ignoreList}
                  busy={busy}
                  options={peopleOptions}
                  searching={searching}
                  selected={selectedPerson}
                  optionLabel={(p) => `${p.fullName ?? p.navIdent} (${p.email})`}
                  optionValue={(p) => p.email ?? ""}
                  rowKey={(p) => String(p.id)}
                  rowTitle={(p) => p.label ?? p.email}
                  rowSub={(p) => (p.label ? p.email : "")}
                  onSearch={searchPeople}
                  onSelect={setSelectedPerson}
                  onAdd={() => void addPerson()}
                  onRemove={(p) => void removeIgnore(p.id)}
                />
              </VStack>
            </section>
            {/* Access control: which Team Catalog groups may open /admin. */}
            <VStack gap="space-12" align="start" style={{ width: "100%" }}>
              <Heading level="3" size="small">
                Who can admin
              </Heading>
              {state.adminBootstrap && (
                <Alert variant="warning" size="small">
                  No admin group configured — right now any logged-in Nav user
                  can change these settings. Add your team to claim the page.
                </Alert>
              )}
              <GroupManager
                title="Admin groups"
                description="Members of these groups can open this page and change settings. Membership resolves live from Team Catalog."
                emptyText="No admin groups yet."
                groups={state.adminGroups}
                busy={busy}
                options={adminGroupOptions}
                searching={adminGroupSearching}
                selected={selectedAdminGroup}
                onSearch={(q) => void searchAdminGroupsFn(q)}
                onSelect={setSelectedAdminGroup}
                onAdd={() => {
                  if (selectedAdminGroup) {
                    void addGroupTo("/api/admin/admins", selectedAdminGroup, () =>
                      setSelectedAdminGroup(null),
                    );
                  }
                }}
                onRemove={(g) => void removeGroupFrom("/api/admin/admins", g)}
              />
              <PersonManager
                title="Admin individuals"
                description="Search by name. Matched by Nav ident — no email needed."
                emptyText="Usually not needed when a team group covers it."
                people={state.adminIdents}
                busy={busy}
                options={adminPeopleOptions}
                searching={adminPeopleSearching}
                selected={selectedAdminPerson}
                optionLabel={(p) =>
                  `${p.fullName ?? p.navIdent}${p.navIdent ? ` (${p.navIdent})` : ""}`
                }
                optionValue={(p) => p.navIdent ?? ""}
                rowKey={(p) => p.nav_ident}
                rowTitle={(p) => p.label ?? p.nav_ident}
                rowSub={(p) => (p.label ? p.nav_ident : "")}
                onSearch={searchAdminPeople}
                onSelect={setSelectedAdminPerson}
                onAdd={() => void addAdminPerson()}
                onRemove={(p) => void removeAdminPerson(p.nav_ident)}
              />
            </VStack>

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
                  {state.frozen ? (
                    <BodyShort textColor="subtle">
                      Bot is off — turn it on to run a scan or post a test
                      digest.
                    </BodyShort>
                  ) : (
                    <HStack gap="space-8" wrap>
                      <Button
                        variant="secondary"
                        size="small"
                        onClick={() => void runTestAction("scan")}
                      >
                        Run scan now
                      </Button>
                      {state.targetChannelId && (
                        <Button
                          variant="secondary"
                          size="small"
                          onClick={() => void runTestAction("ping")}
                        >
                          Post test digest
                        </Button>
                      )}
                    </HStack>
                  )}
                </VStack>
              </ExpansionCard.Content>
            </ExpansionCard>
          </VStack>
        </section>
      </Box>
    </VStack>
  );
}
