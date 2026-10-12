CREATE TABLE "digest_messages" (
	"digest_ts" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"source_channel_id" text NOT NULL,
	"permalink" text NOT NULL,
	"text_excerpt" text NOT NULL,
	"author_label" text NOT NULL,
	"image_url" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_messages_digest_ts_message_ts_pk" PRIMARY KEY("digest_ts","message_ts")
);
--> statement-breakpoint
CREATE TABLE "thread_actions" (
	"message_ts" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"actioned_at" timestamp with time zone DEFAULT now() NOT NULL
);
