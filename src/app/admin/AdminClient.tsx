"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Heading,
  HStack,
  List,
  Loader,
  Select,
  Switch,
  TextField,
  VStack,
} from "@navikt/ds-react";
import { TrashIcon } from "@navikt/aksel-icons";

interface IgnoreEntry {
  id: number;
  slackId: string;
  kind: "user" | "usergroup";
  label: string | null;
}

interface AdminState {
  enabled: boolean;
  nagFrequencyDays: number;
  ignoreList: IgnoreEntry[];
}

export function AdminClient() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newSlackId, setNewSlackId] = useState("");
  const [newKind, setNewKind] = useState<"user" | "usergroup">("user");
  const [newLabel, setNewLabel] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/state", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(`Kunne ikkje hente innstillingar (${res.status})`);
        return;
      }
      setState((await res.json()) as AdminState);
      setLoadError(null);
    } catch {
      setLoadError("Kunne ikkje hente innstillingar");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveSettings = async (patch: { enabled?: boolean; nagFrequencyDays?: number }) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(data?.error ?? `Lagring feila (${res.status})`);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const addIgnore = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/admin/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackId: newSlackId, kind: newKind, label: newLabel }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setActionError(data?.error ?? `Kunne ikkje leggje til (${res.status})`);
        return;
      }
      setNewSlackId("");
      setNewLabel("");
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
        setActionError(`Kunne ikkje fjerne (${res.status})`);
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
        <span>Hentar innstillingar …</span>
      </HStack>
    );
  }

  return (
    <VStack gap="space-24" align="start">
      {actionError && <Alert variant="error">{actionError}</Alert>}

      <Box asChild>
        <section>
          <VStack gap="space-12" align="start">
            <Heading level="2" size="medium" spacing>
              Innstillingar
            </Heading>
            <Switch
              checked={state.enabled}
              disabled={busy}
              onChange={(e) => void saveSettings({ enabled: e.target.checked })}
            >
              Boten er slått på
            </Switch>
            <Select
              label="Påminnelse for meldingar eldre enn"
              value={String(state.nagFrequencyDays)}
              disabled={busy}
              onChange={(e) => void saveSettings({ nagFrequencyDays: Number(e.target.value) })}
              style={{ width: "16rem" }}
            >
              {[1, 2, 3, 5, 7, 10, 14, 21, 30].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? "dag" : "dagar"}
                </option>
              ))}
            </Select>
          </VStack>
        </section>
      </Box>

      <Box asChild>
        <section>
          <VStack gap="space-12" align="start">
            <Heading level="2" size="medium" spacing>
              Ignorarliste
            </Heading>
            <List>
              {state.ignoreList.map((entry) => (
                <List.Item
                  key={entry.id}
                  icon={
                    <Button
                      variant="tertiary"
                      size="small"
                      icon={<TrashIcon aria-hidden />}
                      title={`Fjern ${entry.slackId}`}
                      disabled={busy}
                      onClick={() => void removeIgnore(entry.id)}
                    />
                  }
                >
                  {entry.label ? `${entry.label} — ` : ""}
                  {entry.slackId} ({entry.kind === "user" ? "brukar" : "brukargruppe"})
                </List.Item>
              ))}
            </List>

            <HStack gap="space-8" align="end" wrap>
              <TextField
                label="Slack-ID"
                description="Brukar: U…, brukargruppe: S…"
                value={newSlackId}
                onChange={(e) => setNewSlackId(e.target.value)}
              />
              <Select
                label="Type"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as "user" | "usergroup")}
              >
                <option value="user">Brukar</option>
                <option value="usergroup">Brukargruppe</option>
              </Select>
              <TextField
                label="Namn (valfritt)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <Button
                variant="secondary"
                disabled={busy || !newSlackId.trim()}
                onClick={() => void addIgnore()}
              >
                Legg til
              </Button>
            </HStack>
          </VStack>
        </section>
      </Box>
    </VStack>
  );
}
