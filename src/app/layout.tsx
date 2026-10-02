import type { Metadata } from "next";
import "@navikt/ds-css";

export const metadata: Metadata = {
  title: "ReOps Slack-botar",
  description: "Interne Slack-botar for Team ResearchOps",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nb">
      <body>{children}</body>
    </html>
  );
}
