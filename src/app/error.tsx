"use client";

import { useEffect } from "react";
import { BodyLong, Box, Button, Heading, VStack } from "@navikt/ds-react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server already logs the stack; keep client console quiet for non-tech users.
    console.error(error.digest ?? error.message);
  }, [error]);

  return (
    <Box padding="space-32" asChild>
      <main>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            Noko gjekk gale
          </Heading>
          <BodyLong>
            Sida kunne ikkje visast akkurat no. Dette er oftast forbigaande —
            prøv å laste sida på nytt. Verkar det framleis ikkje? Gi beskjed i
            #researchops-intern, så tek vi ein kikk.
          </BodyLong>
          <Button variant="secondary" onClick={reset}>
            Prøv igjen
          </Button>
        </VStack>
      </main>
    </Box>
  );
}
