CREATE TABLE "reminder_deliveries" (
	"channel_id" text NOT NULL,
	"delivery_ts" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_user_id" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_deliveries_channel_id_delivery_ts_source_channel_id_thread_ts_pk" PRIMARY KEY("channel_id","delivery_ts","source_channel_id","thread_ts"),
	CONSTRAINT "reminder_deliveries_destination_check" CHECK (("reminder_deliveries"."kind" = 'channel_digest' AND "reminder_deliveries"."recipient_user_id" IS NULL) OR ("reminder_deliveries"."kind" = 'assignment_dm' AND "reminder_deliveries"."recipient_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "reminder_threads" (
	"source_channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"permalink" text NOT NULL,
	"text_excerpt" text NOT NULL,
	"author_label" text NOT NULL,
	"image_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_threads_source_channel_id_thread_ts_pk" PRIMARY KEY("source_channel_id","thread_ts")
);
--> statement-breakpoint
ALTER TABLE "reminder_deliveries" ADD CONSTRAINT "reminder_deliveries_source_channel_id_thread_ts_reminder_threads_source_channel_id_thread_ts_fk" FOREIGN KEY ("source_channel_id","thread_ts") REFERENCES "public"."reminder_threads"("source_channel_id","thread_ts") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminder_deliveries_thread_idx" ON "reminder_deliveries" USING btree ("source_channel_id","thread_ts");
--> statement-breakpoint
-- Additive backfill: legacy channel digests become tracked deliveries. Keep
-- legacy tables and all manual actions/settings/cooldowns intact. Assignment
-- DMs were never recorded, so their Slack message pointers cannot be recovered.
INSERT INTO "reminder_threads" ("source_channel_id", "thread_ts", "permalink", "text_excerpt", "author_label", "image_url", "updated_at")
SELECT DISTINCT ON ("source_channel_id", "message_ts")
  "source_channel_id", "message_ts", "permalink", "text_excerpt", "author_label", "image_url", "posted_at"
FROM "digest_messages"
ORDER BY "source_channel_id", "message_ts", "posted_at" DESC, "digest_ts" DESC
ON CONFLICT ("source_channel_id", "thread_ts") DO NOTHING;
--> statement-breakpoint
INSERT INTO "reminder_deliveries" ("channel_id", "delivery_ts", "source_channel_id", "thread_ts", "kind", "recipient_user_id", "posted_at")
SELECT "channel_id", "digest_ts", "source_channel_id", "message_ts", 'channel_digest', NULL, "posted_at"
FROM "digest_messages"
ON CONFLICT ("channel_id", "delivery_ts", "source_channel_id", "thread_ts") DO NOTHING;
