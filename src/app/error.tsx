"use client";

import { useEffect } from "react";
import { BodyLong, Button, Heading, Page, VStack } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";

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
    <PageBlock as="main" width="lg" gutters>
      <div style={{ paddingBlock: "2rem" }}>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            Something went wrong
          </Heading>
          <BodyLong>
            The page failed to load. Usually temporary, try reloading. Still
            broken? Tell us in #researchops-intern.
          </BodyLong>
          <Button variant="secondary" onClick={reset}>
            Try again
          </Button>
        </VStack>
      </div>
    </PageBlock>
  );
}
