import type { Metadata } from "next";
import { Box, Link, Page } from "@navikt/ds-react";
import { PageBlock } from "@navikt/ds-react/Page";
import "@navikt/ds-css";

export const metadata: Metadata = {
  title: "ReOps Slack automation",
  description: "Internal Slack automation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
