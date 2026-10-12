# Agent Notes

## Type Checking

`lsp_diagnostics` is slow. Don't use it for fast iteration.

Use instead:

```zsh
pnpm check
```

Runs `tsc --noEmit`. Fast, reliable. Run after changes to verify types.

## Dev server

```zsh
pnpm dev
```

Starts Next.js on port 9092. `instrumentation.ts` fires bot job startup
automatically (skipped without `DATABASE_URL`).

## Migrations

Drizzle ORM. Schema lives in `src/lib/schema.ts`; SQL migrations in
`drizzle/` (generated). To add one: edit the schema, then
`pnpm dlx drizzle-kit generate` and commit the new `drizzle/NNNN_*.sql` +
`drizzle/meta/*`. Migrations apply automatically at boot via
`src/lib/migrate.ts` (tracked in `drizzle.__drizzle_migrations`).
Fix-forward only — no down-migrations. The Dockerfile COPYs `drizzle/`
into the image; don't remove that line.
