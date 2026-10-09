import { BodyLong, Heading, Link, Page, VStack } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";

export default function NotFoundPage() {
  return (
    <PageBlock as="main" width="lg" gutters>
      <div style={{ paddingBlock: "2rem" }}>
        <VStack gap="space-16" align="start" style={{ maxWidth: "42rem" }}>
          <Heading level="1" size="large">
            Page not found
          </Heading>
          <BodyLong>
            This address does not exist. Old link or typo.
          </BodyLong>
          <Link href="/">Back to front page</Link>
        </VStack>
      </div>
    </PageBlock>
  );
}
