CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"manage_token" text,
	"last_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_email_unique" UNIQUE("email"),
	CONSTRAINT "subscription_confirm_token_hash_unique" UNIQUE("confirm_token_hash"),
	CONSTRAINT "subscription_manage_token_unique" UNIQUE("manage_token"),
	CONSTRAINT "subscription_confirm_token_check" CHECK (("subscription"."confirmed_at" IS NULL) = ("subscription"."confirm_token_hash" IS NOT NULL)),
	CONSTRAINT "subscription_confirm_expires_check" CHECK (("subscription"."confirmed_at" IS NULL) = ("subscription"."confirm_expires_at" IS NOT NULL)),
	CONSTRAINT "subscription_manage_token_check" CHECK (("subscription"."confirmed_at" IS NULL) = ("subscription"."manage_token" IS NULL)),
	CONSTRAINT "subscription_cursor_check" CHECK (("subscription"."confirmed_at" IS NULL) = ("subscription"."last_notified_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "subscription_topic" (
	"subscription_id" uuid NOT NULL,
	"topic" text NOT NULL,
	CONSTRAINT "subscription_topic_subscription_id_topic_pk" PRIMARY KEY("subscription_id","topic"),
	CONSTRAINT "subscription_topic_check" CHECK ("subscription_topic"."topic" IN ('document', 'subprocessor', 'certification', 'advisory'))
);
--> statement-breakpoint
CREATE TABLE "update_post_subprocessor" (
	"post_id" uuid NOT NULL,
	"subprocessor_id" uuid NOT NULL,
	CONSTRAINT "update_post_subprocessor_post_id_subprocessor_id_pk" PRIMARY KEY("post_id","subprocessor_id")
);
--> statement-breakpoint
ALTER TABLE "subscription_topic" ADD CONSTRAINT "subscription_topic_subscription_id_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_post_subprocessor" ADD CONSTRAINT "update_post_subprocessor_post_id_update_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."update_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "update_post_subprocessor" ADD CONSTRAINT "update_post_subprocessor_subprocessor_id_subprocessor_id_fk" FOREIGN KEY ("subprocessor_id") REFERENCES "public"."subprocessor"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subscription_confirm_expires_idx" ON "subscription" USING btree ("confirm_expires_at") WHERE "subscription"."confirmed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "subscription_last_notified_idx" ON "subscription" USING btree ("last_notified_at") WHERE "subscription"."confirmed_at" IS NOT NULL;--> statement-breakpoint
-- Spec §10.1: the fourth actor. Actor types are permanent once written, so
-- this is decided before the first row rather than after. Drizzle regenerates
-- check constraints rather than altering them, so the drop-and-recreate is
-- written by hand and the drizzle/meta snapshot updated to match.
ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_actor_type_check";--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_type_check"
	CHECK ("actor_type" IN ('staff', 'staff-unresolved', 'requester', 'subscriber', 'system'));