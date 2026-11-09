"use client";

import { useEffect, useRef, useState } from "react";
import {
  BodyShort,
  Box,
  Button,
  CopyButton,
  HStack,
  InlineMessage,
  List,
  Loader,
  VStack,
  UNSAFE_Combobox as Combobox,
} from "@navikt/ds-react";
import { DataGrid } from "@navikt/ds-react/PREVIEW";
import { TrashIcon } from "@navikt/aksel-icons";

export interface AudienceGroup {
  id: string;
  kind: "team" | "cluster" | "productarea";
  label: string;
  memberCount: number | null;
  error: string | null;
}
export interface AudiencePerson {
  key: string;
  name: string;
  email: string | null;
  navIdent: string | null;
}
export type AudienceChoice =
  | { type: "group"; id: string; kind: AudienceGroup["kind"]; label: string }
  | {
      type: "person";
      navIdent: string | null;
      fullName: string | null;
      email: string | null;
    };
type SearchOption = { value: string; label: string; choice: AudienceChoice };
type AudienceRow = { id: string; name: string } & (
  | { type: "group"; group: AudienceGroup }
  | { type: "person"; person: AudiencePerson }
);

function GroupDetails({ group }: { group: AudienceGroup }) {
  const [members, setMembers] = useState<Array<{
    navIdent: string | null;
    fullName: string | null;
    email: string | null;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(
      `/api/admin/groups/members?kind=${group.kind}&id=${encodeURIComponent(group.id)}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error("Could not load group members");
        const data = await res.json();
        if (!controller.signal.aborted) setMembers(data.members);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load group members. Try reopening the row.");
      });
    return () => controller.abort();
  }, [group.id, group.kind]);
  return (
    <VStack gap="space-8">
      <HStack gap="space-8" align="center">
        <span className="diagnosticRawValue">Group ID: {group.id}</span>
        <CopyButton copyText={group.id} size="xsmall" title="Copy group ID" />
      </HStack>
      {error ? (
        <InlineMessage status="error" role="alert" size="small">
          {error}
        </InlineMessage>
      ) : !members ? (
        <Loader title="Loading group members" size="small" />
      ) : members.length === 0 ? (
        <BodyShort>No group members found.</BodyShort>
      ) : (
        <List size="small">
          {members.map((member) => (
            <List.Item key={member.email ?? member.navIdent ?? member.fullName}>
              {member.fullName ?? "Unknown person"}
              {member.email ? ` (${member.email})` : ""}
            </List.Item>
          ))}
        </List>
      )}
    </VStack>
  );
}

/** Shared columns keep group names, individual names, metadata and actions aligned. */
export function AudienceManager({
  mode,
  groups,
  people,
  busy,
  onAdd,
  onRemoveGroup,
  onRemovePerson,
}: {
  mode: "ignore" | "admin";
  groups: AudienceGroup[];
  people: AudiencePerson[];
  busy: boolean;
  onAdd: (choice: AudienceChoice) => Promise<boolean>;
  onRemoveGroup: (group: AudienceGroup) => void;
  onRemovePerson: (person: AudiencePerson) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const adding = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setGridWidth(element.clientWidth),
    );
    observer.observe(element);
    setGridWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (reset > 0) inputRef.current?.focus();
  }, [reset]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setOptions([]);
    setSearchError(null);
    if (query.trim().length < 3) {
      setSearching(false);
      return () => controller.abort();
    }
    setSearching(true);
    const timer = setTimeout(() => {
      const q = encodeURIComponent(query.trim());
      const get = async (endpoint: string) => {
        const res = await fetch(`${endpoint}?q=${q}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Search failed");
        return res.json();
      };
      void Promise.allSettled([
        get("/api/admin/groups"),
        get("/api/admin/people"),
      ]).then(([groupResult, personResult]) => {
        if (!active) return;
        const found: SearchOption[] = [];
        if (groupResult.status === "fulfilled")
          for (const group of groupResult.value.groups as Array<{
            id: string;
            kind: AudienceGroup["kind"];
            label: string;
          }>)
            found.push({
              value: `group:${group.kind}:${group.id}`,
              label: `${group.label} — group (${group.kind})`,
              choice: { type: "group", ...group },
            });
        if (personResult.status === "fulfilled")
          for (const person of personResult.value.people as Array<{
            navIdent: string | null;
            fullName: string | null;
            email: string | null;
          }>) {
            const id = mode === "ignore" ? person.email : person.navIdent;
            if (id)
              found.push({
                value: `person:${id.toLowerCase()}`,
                label: `${person.fullName ?? "Unknown person"} (${person.email ?? person.navIdent})`,
                choice: { type: "person", ...person },
              });
          }
        setOptions(found);
        if (
          groupResult.status === "rejected" ||
          personResult.status === "rejected"
        )
          setSearchError(
            "Some search results are unavailable. Try again to include both people and groups.",
          );
        setSearching(false);
      });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, mode]);
  const available = options.filter(({ choice }) =>
    choice.type === "group"
      ? !groups.some(
          (group) => group.kind === choice.kind && group.id === choice.id,
        )
      : !people.some((person) =>
          mode === "ignore"
            ? person.email?.toLowerCase() === choice.email?.toLowerCase()
            : person.navIdent === choice.navIdent,
        ),
  );
  const rows: AudienceRow[] = [
    ...groups.map((group) => ({
      id: `group:${group.kind}:${group.id}`,
      type: "group" as const,
      name: group.label,
      group,
    })),
    ...people.map((person) => ({
      id: `person:${person.key}`,
      type: "person" as const,
      name: person.name,
      person,
    })),
  ];
  const columns: DataGrid.Columns<AudienceRow> = [
    {
      id: "name",
      header: "Name",
      isRowHeader: true,
      width: { defaultValue: 230 },
      bodyCell: (row) => row.name,
    },
    {
      id: "details",
      header: "Contact / members",
      width: { defaultValue: 300 },
      bodyCell: (row) =>
        row.type === "group" ? (
          <span>
            {row.group.kind}
            {row.group.memberCount !== null
              ? ` · ${row.group.memberCount} members`
              : row.group.error
                ? " · count unavailable"
                : ""}
          </span>
        ) : (
          <HStack gap="space-4" align="center">
            <span className="diagnosticRawValue">
              {row.person.email ?? row.person.navIdent}
            </span>
            {(row.person.email ?? row.person.navIdent) && (
              <CopyButton
                copyText={(row.person.email ?? row.person.navIdent)!}
                size="xsmall"
                title={`Copy contact for ${row.name}`}
              />
            )}
          </HStack>
        ),
    },
    ...(people.length
      ? [
          {
            id: "type",
            header: "Type",
            width: { defaultValue: 100 },
            bodyCell: (row: AudienceRow) =>
              row.type === "group" ? "Group" : "Individual",
          },
        ]
      : []),
    {
      id: "actions",
      header: "Actions",
      align: "right",
      width: { defaultValue: 110 },
      bodyCell: (row) => (
        <Button
          type="button"
          variant="tertiary"
          data-color="danger"
          size="xsmall"
          disabled={busy}
          icon={<TrashIcon aria-hidden />}
          aria-label={`Remove ${row.type === "group" ? "group " : ""}${row.name}`}
          onClick={() => {
            if (row.type === "group") onRemoveGroup(row.group);
            else onRemovePerson(row.person);
            inputRef.current?.focus();
          }}
        >
          Remove
        </Button>
      ),
    },
  ];
  // Use Aksel's public controlled-width API instead of styling its filler cell.
  // Reserve 50px for the built-in expand control and 2px for the grid border.
  const fixedWidth = columns.reduce(
    (sum, column) =>
      sum +
      (column.id !== "details" && typeof column.width?.defaultValue === "number"
        ? column.width.defaultValue
        : 0),
    52,
  );
  const fittedColumns = columns.map((column) =>
    column.id === "details"
      ? { ...column, width: { value: Math.max(300, gridWidth - fixedWidth) } }
      : column,
  );
  return (
    <Box
      background="raised"
      borderWidth="1"
      borderColor="neutral-subtle"
      borderRadius="12"
      padding="space-24"
      style={{ width: "100%", minWidth: 0 }}
    >
      <VStack gap="space-16" style={{ width: "100%", minWidth: 0 }}>
        <div ref={gridRef} className="diagnosticsGridViewport">
          {rows.length ? (
            <DataGrid
              columns={fittedColumns}
              data={rows}
              getRowId={(row) => row.id}
              defaultSettings={{
                textSize: "small",
                truncateContent: false,
                stickyColumns: { end: 1 },
              }}
            >
              <DataGrid.Table<AudienceRow>
                stickyHeader={false}
                detailsPanel={{
                  getContent: (row) => (
                    <Box padding="space-16">
                      {row.type === "group" ? (
                        <GroupDetails group={row.group} />
                      ) : (
                        <VStack gap="space-8">
                          <HStack gap="space-8" align="center">
                            Nav ident: {row.person.navIdent ?? "Unknown"}
                            {row.person.navIdent && (
                              <CopyButton
                                copyText={row.person.navIdent}
                                size="xsmall"
                                title="Copy Nav ident"
                              />
                            )}
                          </HStack>
                          <BodyShort>
                            {row.person.email ?? "No email recorded"}
                          </BodyShort>
                        </VStack>
                      )}
                    </Box>
                  ),
                }}
              />
            </DataGrid>
          ) : (
            <BodyShort textColor="subtle">
              No one configured. Add a group to include your whole team.
            </BodyShort>
          )}
        </div>
        <Combobox
          ref={inputRef}
          key={reset}
          label={
            mode === "ignore"
              ? "Add team members or a group"
              : "Add an admin or a group"
          }
          description="Search by name (at least 3 characters). Select a result to add it immediately. Groups add all their members."
          options={available}
          filteredOptions={available}
          selectedOptions={[]}
          isLoading={searching}
          readOnly={busy}
          onChange={setQuery}
          error={searchError}
          onToggleSelected={(value, selected) => {
            const option = available.find((entry) => entry.value === value);
            if (!selected || !option || busy || adding.current) return;
            adding.current = true;
            void onAdd(option.choice)
              .then((ok) => {
                if (ok) {
                  setQuery("");
                  setOptions([]);
                  setReset((value) => value + 1);
                }
              })
              .catch(() =>
                setSearchError("Could not add this entry. Please try again."),
              )
              .finally(() => {
                adding.current = false;
              });
          }}
        />
      </VStack>
    </Box>
  );
}
