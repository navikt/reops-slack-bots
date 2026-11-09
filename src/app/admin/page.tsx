import { headers } from "next/headers";
import { BodyShort, Heading, LocalAlert, VStack } from "@navikt/ds-react";
import {
  LocalAlertHeader,
  LocalAlertTitle,
  LocalAlertContent,
} from "@navikt/ds-react/LocalAlert";
import { PageBlock } from "@navikt/ds-react/Page";
import { requireAdmin } from "../../lib/auth";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const req = new Request("https://internal/admin", {
    headers: await headers(),
  });
  const auth = await requireAdmin(req);

  return (
    <PageBlock as="main" width="lg" gutters>
      <div style={{ paddingBlock: "2rem" }}>
        <VStack gap="space-24" align="start">
          <Heading level="1" size="large">
            Unanswered messages admin
          </Heading>

          {auth.status === "unauthenticated" && (
            <LocalAlert status="warning">
              <LocalAlertHeader>
                <LocalAlertTitle>Not logged in</LocalAlertTitle>
              </LocalAlertHeader>
              <LocalAlertContent>
                Log in with your Nav account.
              </LocalAlertContent>
            </LocalAlert>
          )}

          {auth.status === "forbidden" && (
            <LocalAlert status="error">
              <LocalAlertHeader>
                <LocalAlertTitle>Admins only</LocalAlertTitle>
              </LocalAlertHeader>
              <LocalAlertContent>
                Admins only. Ask an existing admin to add your team under
                &quot;Who can admin&quot;.
              </LocalAlertContent>
            </LocalAlert>
          )}

          {auth.status === "unavailable" && (
            <LocalAlert status="error">
              <LocalAlertHeader>
                <LocalAlertTitle>
                  Could not verify team membership
                </LocalAlertTitle>
              </LocalAlertHeader>
              <LocalAlertContent>Try again later.</LocalAlertContent>
            </LocalAlert>
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
