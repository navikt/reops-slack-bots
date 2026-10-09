import { headers } from "next/headers";
import { Alert, BodyShort, Heading, Page, VStack } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";
import { requireReopsTeamMember } from "../../lib/auth";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const req = new Request("https://internal/admin", {
    headers: await headers(),
  });
  const auth = await requireReopsTeamMember(req);

  return (
    <PageBlock as="main" width="lg" gutters>
      <div style={{ paddingBlock: "2rem" }}>
        <VStack gap="space-24" align="start">
          <Heading level="1" size="large">
            Unanswered messages admin
          </Heading>

          {auth.status === "unauthenticated" && (
            <Alert variant="warning">
              Not logged in. Log in with your Nav account.
            </Alert>
          )}

          {auth.status === "forbidden" && (
            <Alert variant="error">
              Team ResearchOps only.
            </Alert>
          )}

          {auth.status === "unavailable" && (
            <Alert variant="error">
              Could not verify team membership. Try again later.
            </Alert>
          )}

          {auth.status === "ok" && (
            <>
              <BodyShort>
                Logged in as {auth.user.name} ({auth.user.navIdent}).
              </BodyShort>
              <AdminClient />
            </>
          )}
        </VStack>
      </div>
    </PageBlock>
  );
}
