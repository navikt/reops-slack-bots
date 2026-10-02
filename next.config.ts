import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    // Tree-shake Aksel DS — prevents pulling the whole package
    optimizePackageImports: ["@navikt/ds-react", "@navikt/aksel-icons"],
  },
};

export default nextConfig;
