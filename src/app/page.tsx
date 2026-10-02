import { BodyShort, Box, Heading, Link, VStack } from "@navikt/ds-react";

export default function HomePage() {
  return (
    <Box padding="space-32" asChild>
      <main>
        <VStack gap="space-16" align="start">
          <Heading level="1" size="large">
            ReOps Slack-botar
          </Heading>
          <BodyShort>
            Interne Slack-botar for Team ResearchOps. Første bot: påminnelse om
            ubesvarte meldingar i #researchops.
          </BodyShort>
          <Link href="/admin">Gå til admin</Link>
        </VStack>
      </main>
    </Box>
  );
}
