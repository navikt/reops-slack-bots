import { defineConfig } from "drizzle-kit";

/**
 * Config for local drizzle-kit commands (generate/introspect) only — kit
 * never runs in prod. The app itself applies drizzle/*.sql at boot via
 * drizzle-orm's migrator (src/lib/migrate.ts).
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "src/lib/schema.ts",
  out: "drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:dev@localhost:5432/slackbots",
  },
});
