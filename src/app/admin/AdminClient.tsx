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
  Box,
  Button,
  ExpansionCard,
  Heading,
  HStack,
  InlineMessage,
  Link,
  LocalAlert,
  Loader,
  Provider,
  Select,
  Switch,
  VStack,
} from "@navikt/ds-react";
import { en } from "@navikt/ds-react/locales";
import {
  AudienceManager,
  type AudienceChoice,
  type AudienceGroup,
  type AudiencePerson,
} from "./AudienceManager";
import { HandledEmojiEditor } from "./HandledEmojiEditor";
import {
  diagnosticChannel,
  type ChannelIdentity,
  type DiagnosticThread,
  type PersonIdentity,
} from "../../lib/admin-diagnostics";
import "./admin.css";

export interface AdminState {
  frozen: boolean;
  scanWindowDays: number;
  minAgeHours: number;
  reNagHours: number;
  workHoursAware: boolean;
  handledEmojis: string;
  sourceChannelId: string | null;
  targetChannelId: string | null;
  channels: Array<{ id: string; name: string; isPrivate: boolean }>;
  channelsError: string | null;
  lastScan: { at: string; unsolved: number; nagged: number } | null;
  groups: AudienceGroup[];
  ignorePersons: Array<{
    id: number;
    label: string | null;
    navIdent: string | null;
    email: string;
  }>;
  adminGroups: AudienceGroup[];
  adminPersons: Array<{ nav_ident: string; label: string | null }>;
  adminBootstrap: boolean;
  tableCounts: Array<{ table: string; rows: number }>;
  you: {
    navIdent: string;
    email: string | null;
    slackUserId: string | null;
    ignored: boolean;
  } | null;
  diagnostics: DiagnosticThread[];
  assignees: Array<{ userId: string; label: string }>;
  channelIdentities: Record<string, ChannelIdentity>;
  people: Record<string, PersonIdentity>;
}

type SettingsPatch = Partial<
  Pick<
    AdminState,
    | "frozen"
    | "scanWindowDays"
    | "minAgeHours"
    | "reNagHours"
    | "workHoursAware"
    | "handledEmojis"
    | "sourceChannelId"
    | "targetChannelId"
  >
>;
const RE_NAG_OPTIONS = [0.5, 1, 2, 3, 24, 48, 72, 120, 168, 336];
const hoursLabel = (hours: number) =>
  hours < 1
    ? "30 minutes"
    : hours < 24
      ? `${hours} ${hours === 1 ? "hour" : "hours"}`
      : `${hours / 24} ${hours === 24 ? "day" : "days"}`;
const numbers = (defaults: number[], value: number) =>
  [...new Set([...defaults, value])].sort((a, b) => a - b);

function Notice({
  status,
  title,
  children,
}: {
  status: "error" | "warning";
  title?: string;
  children: ReactNode;
}) {
  return (
    <LocalAlert status={status} size="small" as="div">
      <LocalAlert.Header>
        <LocalAlert.Title as="div">
          {title ??
            (status === "error"
              ? "Something needs attention"
              : "Check your configuration")}
        </LocalAlert.Title>
      </LocalAlert.Header>
      <LocalAlert.Content>{children}</LocalAlert.Content>
    </LocalAlert>
  );
}

function SettingsCard({ children }: { children: ReactNode }) {
  return (
    <Box
      background="raised"
      borderWidth="1"
      borderColor="neutral-subtle"
      borderRadius="12"
      padding="space-24"
      style={{ width: "100%" }}
    >
      {children}
    </Box>
  );
}

function AdminSettings() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`Could not load settings (${res.status})`);
      setState((await res.json()) as AdminState);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load settings",
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let wasHidden = false;
    let lastFetch = 0;
    const visibility = () => {
      wasHidden = document.hidden;
    };
    const focus = () => {
      if (!wasHidden || mutating.current || Date.now() - lastFetch < 5000)
        return;
      lastFetch = Date.now();
      wasHidden = false;
      void load();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, [load]);

  const mutate = async (
    endpoint: string,
    method: "POST" | "DELETE",
    body: object,
    success?: string,
  ): Promise<boolean> => {
    if (mutating.current) return false;
    mutating.current = true;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const res = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        throw new Error(
          data?.detail ?? data?.error ?? `Action failed (${res.status})`,
        );
      }
      await load();
      if (success) setMessage(success);
      return true;
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : "Could not save. Check your connection.",
      );
      return false;
    } finally {
      mutating.current = false;
      setBusy(false);
    }
  };
  const saveSettings = (patch: SettingsPatch) =>
    mutate("/api/admin/settings", "POST", patch);
  const addAudience = (mode: "admin" | "ignore", choice: AudienceChoice) => {
    const endpoint =
      mode === "admin"
        ? "/api/admin/admins"
        : choice.type === "group"
          ? "/api/admin/groups"
          : "/api/admin/ignore";
    const payload =
      choice.type === "group"
        ? { id: choice.id, kind: choice.kind, label: choice.label }
        : mode === "admin"
          ? { navIdent: choice.navIdent, label: choice.fullName }
          : {
              email: choice.email,
              navIdent: choice.navIdent,
              label: choice.fullName,
            };
    return mutate(endpoint, "POST", payload, "Access list updated.");
  };
  const removeGroup = (mode: "admin" | "ignore", group: AudienceGroup) =>
    mutate(
      mode === "admin" ? "/api/admin/admins" : "/api/admin/groups",
      "DELETE",
      { kind: group.kind, id: group.id },
      "Group removed.",
    );
  const removePerson = (mode: "admin" | "ignore", person: AudiencePerson) =>
    mutate(
      mode === "admin" ? "/api/admin/admins" : "/api/admin/ignore",
      "DELETE",
      mode === "admin"
        ? { navIdent: person.navIdent }
        : { id: Number(person.key) },
      "Individual removed.",
    );

  if (!state)
    return (
      <VStack gap="space-12">
        {loadError ? (
          <>
            <Notice status="error">{loadError}</Notice>
            <Button
              size="small"
              variant="secondary"
              onClick={() => void load()}
            >
              Reload settings
            </Button>
          </>
        ) : (
          <HStack gap="space-8" align="center">
            <Loader size="small" title="Loading settings" />
            <span>Loading settings…</span>
          </HStack>
        )}
      </VStack>
    );

  const channel = (id: string | null) =>
    id ? diagnosticChannel(id, state.channelIdentities) : null;
  const channelOptions = (current: string | null) => (
    <>
      <option value="">Not selected</option>
      {current && !state.channels.some((entry) => entry.id === current) && (
        <option value={current}>
          {channel(current)?.resolved
            ? channel(current)!.name
            : "Configured channel (name unavailable)"}
        </option>
      )}
      {state.channels.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.isPrivate ? "🔒 " : "#"}
          {entry.name}
        </option>
      ))}
    </>
  );
  const ignorePeople: AudiencePerson[] = state.ignorePersons.map((person) => ({
    key: String(person.id),
    name: person.label ?? person.email,
    email: person.email,
    navIdent: person.navIdent,
  }));
  const adminPeople: AudiencePerson[] = state.adminPersons.map((person) => ({
    key: person.nav_ident,
    name: person.label ?? "Admin individual",
    navIdent: person.nav_ident,
    email: null,
  }));

  return (
    <VStack gap="space-24" style={{ width: "100%" }}>
      {loadError && (
        <Notice status="error">
          {loadError}{" "}
          <Button size="xsmall" variant="secondary" onClick={() => void load()}>
            Refresh
          </Button>
        </Notice>
      )}
      {actionError && (
        <Notice status="error" title="Could not save changes">
          {actionError}
        </Notice>
      )}
      <div role="status">
        {message && <InlineMessage status="success">{message}</InlineMessage>}
      </div>

      <SettingsCard>
        <VStack gap="space-12" align="start">
          <Heading level="2" size="medium">
            Bot on/off
          </Heading>
          <BodyShort>
            Turning the bot off prevents Slack calls and scheduled reminders.
          </BodyShort>
          <Switch
            checked={!state.frozen}
            disabled={busy}
            onChange={(e) => void saveSettings({ frozen: !e.target.checked })}
          >
            Bot is active
          </Switch>
          {state.frozen && (
            <Notice status="warning" title="Bot paused">
              No Slack activity until turned on.
            </Notice>
          )}
        </VStack>
      </SettingsCard>

      <Box
        background="sunken"
        borderWidth="1"
        borderColor="neutral-subtle"
        borderRadius="12"
        padding="space-24"
        style={{ width: "100%" }}
      >
        <VStack gap="space-24" style={{ width: "100%" }}>
          <Heading level="2" size="medium">
            Unanswered messages
          </Heading>
          <BodyShort>
            Hourly scans remind the team about open threads, either in the
            channel digest or the assigned teammate’s DM.
          </BodyShort>
          <section>
            <Heading level="3" size="small" spacing>
              Status
            </Heading>
            <BodyShort textColor="subtle">
              {state.lastScan ? (
                <>
                  Last scan:{" "}
                  {new Date(state.lastScan.at).toLocaleString("en-GB")}.{" "}
                  {state.lastScan.unsolved} candidate threads,{" "}
                  {state.lastScan.nagged} due for reminders. Runs hourly.
                </>
              ) : (
                "No scan yet. First run starts within an hour of boot."
              )}
            </BodyShort>
          </section>
          <Heading level="3" size="small">
            Settings
          </Heading>
          <SettingsCard>
            <VStack gap="space-12">
              <Heading level="4" size="xsmall">
                Timing
              </Heading>
              <div className="fieldRow">
                <Select
                  label="Scan window"
                  description="Ignore messages older than this."
                  disabled={busy}
                  value={String(state.scanWindowDays)}
                  onChange={(e) =>
                    void saveSettings({
                      scanWindowDays: Number(e.target.value),
                    })
                  }
                >
                  {numbers(
                    [1, 2, 3, 5, 7, 10, 14, 21, 30],
                    state.scanWindowDays,
                  ).map((days) => (
                    <option key={days} value={days}>
                      {days} {days === 1 ? "day" : "days"}
                    </option>
                  ))}
                </Select>
                <Select
                  label="Grace period"
                  description="Work hours (Mon–Fri 09:00–16:30) before a thread becomes eligible. Evening posts wait until next morning."
                  disabled={busy}
                  value={String(state.minAgeHours)}
                  onChange={(e) =>
                    void saveSettings({ minAgeHours: Number(e.target.value) })
                  }
                >
                  {numbers([0, 1, 2, 4, 8, 24], state.minAgeHours).map(
                    (hours) => (
                      <option key={hours} value={hours}>
                        {hours === 0 ? "None" : hoursLabel(hours)}
                      </option>
                    ),
                  )}
                </Select>
                <Select
                  label="Re-remind after"
                  description="Cooldown before another reminder for a thread."
                  disabled={busy}
                  value={String(state.reNagHours)}
                  onChange={(e) =>
                    void saveSettings({ reNagHours: Number(e.target.value) })
                  }
                >
                  {numbers(RE_NAG_OPTIONS, state.reNagHours).map((hours) => (
                    <option key={hours} value={hours}>
                      {hoursLabel(hours)}
                    </option>
                  ))}
                </Select>
              </div>
            </VStack>
          </SettingsCard>
          <SettingsCard>
            <VStack gap="space-12">
              <Heading level="4" size="xsmall">
                Channels
              </Heading>
              <BodyShort>Invite @reops to a channel to list it here.</BodyShort>
              {state.channelsError && (
                <Notice status="warning">
                  Could not list channels: {state.channelsError}
                </Notice>
              )}
              <div className="fieldRow">
                <Select
                  label="Channel to monitor"
                  description="Checked for unanswered threads."
                  disabled={busy}
                  value={state.sourceChannelId ?? ""}
                  onChange={(e) =>
                    void saveSettings({
                      sourceChannelId: e.target.value || null,
                    })
                  }
                >
                  {channelOptions(state.sourceChannelId)}
                </Select>
                <Select
                  label="Channel for reminders"
                  description="The team digest is posted here."
                  disabled={busy}
                  value={state.targetChannelId ?? ""}
                  onChange={(e) =>
                    void saveSettings({
                      targetChannelId: e.target.value || null,
                    })
                  }
                >
                  {channelOptions(state.targetChannelId)}
                </Select>
              </div>
            </VStack>
          </SettingsCard>
          <HandledEmojiEditor
            savedValue={state.handledEmojis}
            busy={busy}
            onSave={(handledEmojis) => saveSettings({ handledEmojis })}
          />

          <section>
            <VStack gap="space-12">
              <Heading level="3" size="small">
                Who gets ignored
              </Heading>
              <BodyShort textColor="subtle">
                Messages from these people never trigger reminders. Their latest
                thread reply counts as handled; configured reactions also count
                until a later follow-up.
              </BodyShort>
              <AudienceManager
                mode="ignore"
                groups={state.groups}
                people={ignorePeople}
                busy={busy}
                onAdd={(choice) => addAudience("ignore", choice)}
                onRemoveGroup={(group) => void removeGroup("ignore", group)}
                onRemovePerson={(person) => void removePerson("ignore", person)}
              />
            </VStack>
          </section>
          <section>
            <VStack gap="space-12">
              <Heading level="3" size="small">
                Who can admin
              </Heading>
              <BodyShort textColor="subtle">
                Members of these groups and individuals can change settings.
                Group membership is checked through Team Catalog.
              </BodyShort>
              {state.adminBootstrap && (
                <Notice status="warning" title="Admin access is not restricted">
                  No admins configured. Any logged-in Nav user can currently
                  change settings. Add your team to claim the page.
                </Notice>
              )}
              <AudienceManager
                mode="admin"
                groups={state.adminGroups}
                people={adminPeople}
                busy={busy}
                onAdd={(choice) => addAudience("admin", choice)}
                onRemoveGroup={(group) => void removeGroup("admin", group)}
                onRemovePerson={(person) => void removePerson("admin", person)}
              />
            </VStack>
          </section>

          <ExpansionCard aria-label="Advanced" size="small">
            <ExpansionCard.Header>
              <ExpansionCard.Title as="h3" size="small">
                Advanced
              </ExpansionCard.Title>
            </ExpansionCard.Header>
            <ExpansionCard.Content>
              <VStack gap="space-16">
                <Switch
                  checked={state.workHoursAware}
                  disabled={busy}
                  onChange={(e) =>
                    void saveSettings({ workHoursAware: e.target.checked })
                  }
                  description="When on, the grace period for off-hours messages starts at the next Mon–Fri 09:00 opening. Turn off to count plain wall-clock time; sending still stays inside work hours."
                >
                  Smart work-hours awareness
                </Switch>
                <HStack gap="space-8">
                  {(
                    [
                      ["scan_force", "Run scan now (ignore cooldown)"],
                      ["ping", "Post test digest"],
                      ["dm", "Send test DM to me"],
                    ] as const
                  ).map(([action, label]) => (
                    <Button
                      key={action}
                      type="button"
                      variant="secondary"
                      size="small"
                      disabled={busy || state.frozen}
                      onClick={() =>
                        void mutate(
                          "/api/admin/test",
                          "POST",
                          { action },
                          "Test action completed.",
                        )
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </HStack>
                <BodyShort size="small" textColor="subtle">
                  A forced scan writes reminder cooldowns and sends real
                  reminders. Test digest and DM buttons send clearly marked fake
                  examples.
                </BodyShort>
                <Link href="/admin/diagnostics">Open thread diagnostics →</Link>
              </VStack>
            </ExpansionCard.Content>
          </ExpansionCard>
        </VStack>
      </Box>
    </VStack>
  );
}

export function AdminClient() {
  return (
    <Provider locale={en}>
      <AdminSettings />
    </Provider>
  );
}
