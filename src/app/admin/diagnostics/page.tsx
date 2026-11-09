import { headers } from "next/headers";
import { Heading, Link, LocalAlert, VStack } from "@navikt/ds-react";
import {
  LocalAlertHeader,
  LocalAlertTitle,
  LocalAlertContent,
} from "@navikt/ds-react/LocalAlert";
import { PageBlock } from "@navikt/ds-react/Page";
import { requireAdmin } from "../../../lib/auth";
import { DiagnosticsClient } from "./DiagnosticsClient";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
  const auth = await requireAdmin(
    new Request("https://internal/admin/diagnostics", {
      headers: await headers(),
    }),
  );
  return (
    <PageBlock as="main" width="2xl" gutters>
      <VStack gap="space-24" className="diagnosticsPage">
        <Link href="/admin">← Back to bot settings</Link>
        <Heading level="1" size="large">
          Reminder diagnostics
        </Heading>
        {auth.status === "ok" ? (
          <DiagnosticsClient />
        ) : (
          <LocalAlert status="error" as="div">
            <LocalAlertHeader>
              <LocalAlertTitle>Admin access required</LocalAlertTitle>
            </LocalAlertHeader>
            <LocalAlertContent>
              {auth.status === "unauthenticated"
                ? "Log in with your Nav account."
                : auth.status === "forbidden"
                  ? "Ask an existing admin to add you or your team."
                  : "Could not verify access. Try again later."}
            </LocalAlertContent>
          </LocalAlert>
        )}
      </VStack>
    </PageBlock>
  );
}
