-- Baseline: initial schema for the drizzle cutover (Oct 2026). The pre-drizzle
-- prod DB was wiped at cutover, so this runs everywhere as a fresh install.
CREATE TABLE "admin_groups" (
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "admin_groups_id_kind_pk" PRIMARY KEY("id","kind"),
	CONSTRAINT "admin_groups_kind_check" CHECK ("admin_groups"."kind" IN ('team', 'cluster', 'productarea'))
);
--> statement-breakpoint
CREATE TABLE "admin_persons" (
	"nav_ident" text PRIMARY KEY NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ignore_groups" (
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	CONSTRAINT "ignore_groups_id_kind_pk" PRIMARY KEY("id","kind"),
	CONSTRAINT "ignore_groups_kind_check" CHECK ("ignore_groups"."kind" IN ('team', 'cluster', 'productarea'))
);
--> statement-breakpoint
CREATE TABLE "ignore_persons" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text,
	"nav_ident" text,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ignore_persons_kind_check" CHECK ("ignore_persons"."kind" IN ('person'))
);
--> statement-breakpoint
CREATE TABLE "nag_log" (
	"message_ts" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"last_nagged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
-- Seed data formerly applied by src/lib/migrations/001_init.sql and
-- 002_re_nag_hours.sql (drizzle-kit does not generate data inserts; appended
-- manually — keep when regenerating).
INSERT INTO "settings" ("key", "value") VALUES
	('scan_window_days', '14'),
	('min_age_hours', '1'),
	('frozen', 'true')
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES ('re_nag_hours', '168')
ON CONFLICT ("key") DO NOTHING;
