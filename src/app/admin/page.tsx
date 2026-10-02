import { headers } from "next/headers";
import { Alert, BodyShort, Box, Heading, VStack } from "@navikt/ds-react";
import { requireReopsTeamMember } from "../../lib/auth";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const req = new Request("https://internal/admin", {
    headers: await headers(),
  });
  const auth = await requireReopsTeamMember(req);

  return (
    <Box padding="space-32" asChild>
      <main>
        <VStack gap="space-24" align="start">
          <Heading level="1" size="large">
            Ubesvarte meldingar — admin
          </Heading>

          {auth.status === "unauthenticated" && (
            <Alert variant="warning">
              Du er ikkje innlogga. Logg inn med Nav-kontoen din for å sjå denne
              sida.
            </Alert>
          )}

          {auth.status === "forbidden" && (
            <Alert variant="error">
              Denne sida er berre tilgjengeleg for Team ResearchOps.
            </Alert>
          )}

          {auth.status === "unavailable" && (
            <Alert variant="error">
              Kunne ikkje verifisere teammedlemskap (Team Catalog utilgjengeleg).
              Prøv igjen seinare.
            </Alert>
          )}

          {auth.status === "ok" && (
            <>
              <BodyShort>
                Innlogga som {auth.user.name} ({auth.user.navIdent}).
              </BodyShort>
              <AdminClient />
            </>
          )}
        </VStack>
      </main>
    </Box>
  );
}
