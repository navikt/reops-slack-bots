import type { Metadata } from "next";
import { Box, Link, Page } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";
import "@navikt/ds-css";
import { startServer } from "../../server";

export const metadata: Metadata = {
  title: "ReOps Slack automation",
  description: "Internal Slack automation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Standalone builds don't reliably invoke instrumentation.ts register()
  // (vercel/next.js#49897) — kick off boot work here too. startServer is
  // idempotent (guarded), so the instrumentation path stays the fast one.
  void startServer();

  return (
    <html lang="en">
      <body>
        <Page
          contentBlockPadding="end"
          footer={
            <Box
              borderWidth="1 0 0 0"
              borderColor="neutral-subtle"
              padding="space-24"
              asChild
            >
              <PageBlock width="lg" gutters>
                <Link href="https://github.com/navikt/reops-slack-bots" target="_blank">
                  Source: github.com/navikt/reops-slack-bots
                </Link>
              </PageBlock>
            </Box>
          }
        >
          {children}
        </Page>
      </body>
    </html>
  );
}
