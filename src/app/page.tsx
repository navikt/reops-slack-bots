import { headers } from "next/headers";
import { Alert, BodyLong, BodyShort, Heading, Link, List, Page, VStack } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";
// RSC can't serialize dot-notation (<List.Item>) — import the component directly.
import { ListItem } from "@navikt/ds-react/List";
import { getSetting } from "../lib/db";
import { listJoinedChannels } from "../lib/slack";
import { requireAdmin } from "../lib/auth";

export const dynamic = "force-dynamic";

/** "30 minutes" / "1 hour" / "3 hours" / "1 day" / "7 days" from an hour count. */
function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = hours / 24;
  return `${days} ${days === 1 ? "day" : "days"}`;
}

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
  const auth = await requireAdmin(req);

  // Info page is public (internal ingress); failures just degrade the detail level.
  let channels: Awaited<ReturnType<typeof listJoinedChannels>> = [];
  let sourceChannelId: string | null = null;
  let targetChannelId: string | null = null;
  let scanWindowDays = 14;
  let graceHours = 1;
  let reNagHours = 168;
  let frozen = false;
  try {
    const [s, t, sw, gh, rh, frozenRaw] = await Promise.all([
      getSetting("unanswered_reminder.source_channel_id"),
      getSetting("unanswered_reminder.target_channel_id"),
      getSetting("scan_window_days"),
      getSetting("min_age_hours"),
      getSetting("re_nag_hours"),
      getSetting("frozen"),
    ]);
    sourceChannelId = s;
    targetChannelId = t;
    scanWindowDays = Number.parseInt(sw ?? "14", 10) || 14;
    graceHours = Number.parseInt(gh ?? "1", 10) || 0;
    reNagHours = Number.parseFloat(rh ?? "168") || 168;
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
            On a regular schedule, the bot checks{" "}
            {source ? <strong>{source}</strong> : "the chosen channel"} for messages
            still awaiting an answer after a grace period of {formatHours(graceHours)} of
            work time (Mon–Fri 09:00–16:30 — an evening post becomes due the next
            workday morning). Hits are collected into a digest{" "}
            {target ? <>in <strong>{target}</strong></> : "in the reminder channel"} —
            a link per message, which Slack expands into a preview. A message counts
            as answered when:
          </BodyLong>
          <List>
            <ListItem>
              a :solved: reaction marks it handled — on the original message or any
              thread reply, set by team or asker, or
            </ListItem>
            <ListItem>a team member wrote the last thread reply.</ListItem>
          </List>
          <BodyLong>
            Both are recency-based: a follow-up question from a non-team member
            re-opens the thread, and it is marked handled again by re-adding :solved:
            or replying.
          </BodyLong>
          <BodyLong>
            Unanswered messages re-appear in the digest every {formatHours(reNagHours)}{" "}
            until handled, and are ignored once older than {scanWindowDays} days.
          </BodyLong>

          <Heading level="2" size="medium">
            Usage
          </Heading>
          <List>
            <ListItem>
              Answered? Reply in the thread, or add :solved: to the message — both
              mark it handled until someone asks a follow-up.
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
