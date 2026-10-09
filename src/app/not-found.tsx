import { BodyLong, Box, Heading, Link, VStack } from "@navikt/ds-react";

export default function NotFoundPage() {
  return (
    <Box padding="space-32" asChild>
      <main>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            Fann ikkje sida
          </Heading>
          <BodyLong>
            Denne adressa finst ikkje. Kanskje lenkja er gammal, eller det har
            smytt seg inn ein skrivefeil?
          </BodyLong>
          <Link href="/">Til forsida</Link>
        </VStack>
      </main>
    </Box>
  );
}
