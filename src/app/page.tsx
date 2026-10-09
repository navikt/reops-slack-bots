import { headers } from "next/headers";
import { Alert, BodyLong, BodyShort, Heading, Link, List, Page, VStack } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";
// RSC can't serialize dot-notation (<List.Item>) — import the component directly.
import { ListItem } from "@navikt/ds-react/List";
import { getSetting } from "../lib/db";
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
  let scanWindowDays = "14";
  let frozen = false;
  try {
    let frozenRaw: string | null;
    [sourceChannelId, targetChannelId, scanWindowDays, frozenRaw] = await Promise.all([
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("scan_window_days"),
      getSetting("frozen"),
    ]).then(([s, t, f, fr]): [string | null, string | null, string, string | null] => [
      s,
      t,
      f ?? "14",
      fr,
    ]);
    frozen = frozenRaw === "true";
    if (!frozen) {
      channels = await listJoinedChannels();
    }
  } catch {
    // DB or Slack unavailable — render the static explainer only.
  }

  const source = channelName(channels, sourceChannelId || null);
  const target = channelName(channels, targetChannelId || null);

  return (
    <PageBlock as="main" width="lg" gutters>
      <div style={{ paddingBlock: "2rem" }}>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            ReOps Slack automation
          </Heading>

          {frozen && (
            <Alert variant="info">
              The bot is paused by the team.
            </Alert>
          )}

          <BodyLong>
            <strong>@reops</strong> tracks unanswered questions for Team
            ResearchOps.
          </BodyLong>

          <Heading level="2" size="medium">
            Unanswered messages
          </Heading>
          <BodyLong>
            Hourly, the bot checks {source ? <strong>{source}</strong> : "the chosen channel"}{" "}
            for messages unanswered for over an hour. Hits get a reminder{" "}
            {target ? <>in <strong>{target}</strong></> : "in the reminder channel"} with a
            "Mark as solved" button. Answered means:
          </BodyLong>
          <List>
            <ListItem>a :solved: reaction exists, or</ListItem>
            <ListItem>a team member wrote the last thread reply.</ListItem>
          </List>
          <BodyLong>
            Messages older than {scanWindowDays || "14"} days are ignored.
          </BodyLong>

          <Heading level="2" size="medium">
            Usage
          </Heading>
          <List>
            <ListItem>
              Solved? Add :solved: or click "Mark as solved" on the reminder.
            </ListItem>
            <ListItem>
              Add the bot to a channel: <code>/invite @reops</code>.
            </ListItem>
          </List>

          <BodyShort>
            <Link href="/admin">
              {auth.status === "ok" ? "Go to admin" : "Admin (Team ResearchOps)"}
            </Link>
          </BodyShort>
        </VStack>
      </div>
    </PageBlock>
  );
}
