import { headers } from "next/headers";
import { BodyLong, BodyShort, Box, Heading, Link, List, VStack } from "@navikt/ds-react";
import { getSetting, listIgnoreEntries } from "../lib/db";
import { listJoinedChannels } from "../lib/slack";
import { requireReopsTeamMember } from "../lib/auth";

export const dynamic = "force-dynamic";

function channelName(
  channels: Awaited<ReturnType<typeof listJoinedChannels>>,
  id: string | null,
): string | null {
  if (!id) return null;
  const ch = channels.find((c) => c.id === id);
  return ch ? `${ch.isPrivate ? "🔒 " : "#"}${ch.name}` : null;
}

export default async function HomePage() {
  const req = new Request("https://internal/", { headers: await headers() });
  const auth = await requireReopsTeamMember(req);

  // Info page is public (internal ingress); failures just degrade the detail level.
  let channels: Awaited<ReturnType<typeof listJoinedChannels>> = [];
  let sourceChannelId: string | null = null;
  let targetChannelId: string | null = null;
  let nagFrequencyDays = "14";
  try {
    [sourceChannelId, targetChannelId, nagFrequencyDays] = await Promise.all([
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("nag_frequency_days"),
    ]).then(([s, t, f]): [string | null, string | null, string] => [s, t, f ?? "14"]);
    channels = await listJoinedChannels();
  } catch {
    // DB or Slack unavailable — render the static explainer only.
  }

  const source = channelName(channels, sourceChannelId || null);
  const target = channelName(channels, targetChannelId || null);

  return (
    <Box padding="space-32" asChild>
      <main>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            ReOps — Slack-automatisering
          </Heading>

          <BodyLong>
            Boten <strong>@reops</strong> hjelper Team ResearchOps med å halde
            styr på spørsmål i Slack-kanalane våre.
          </BodyLong>

          <Heading level="2" size="medium">
            Ubesvarte meldingar
          </Heading>
          <BodyLong>
            Ein gong i timen sjekkar boten
            {source ? <> kanalen <strong>{source}</strong></> : <> den valde kanalen</>}{" "}
            for meldingar som har stått ubesvarte i over ein time. Finn han
            nokon, postast ei påminning
            {target ? <> i <strong>{target}</strong></> : <> i påminningskanalen</>}{" "}
            med ei «Merk som løst»-knapp. Ein melding tel som besvart når:
          </BodyLong>
          <List>
            <List.Item>nokon legg på ein :solved:-reaksjon, eller</List.Item>
            <List.Item>
              eit teammedlem har skrive det siste svaret i tråden.
            </List.Item>
          </List>
          <BodyLong>
            Meldingar eldre enn {nagFrequencyDays || "14"} dagar blir ikkje
            plukka opp — har noko stått så lenge, er det anten løyst i praksis
            eller gløymt over ei ferieuke.
          </BodyLong>

          <Heading level="2" size="medium">
            Bruk
          </Heading>
          <List>
            <List.Item>
              Løyst eit spørsmål? Legg på ein :solved:-reaksjon, eller klikk
              «Merk som løst» på påminninga.
            </List.Item>
            <List.Item>
              Vil du ha boten i ein kanal? Inviter med <code>/invite @reops</code>.
            </List.Item>
          </List>

          <BodyShort>
            <Link href="/admin">
              {auth.status === "ok" ? "Gå til admin" : "Admin (Team ResearchOps)"}
            </Link>
          </BodyShort>
        </VStack>
      </main>
    </Box>
  );
}
