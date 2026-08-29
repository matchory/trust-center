CREATE TABLE "outbound_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to" text NOT NULL,
	"template" text NOT NULL,
	"locale" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_email_status_check" CHECK ("outbound_email"."status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "outbound_email_claim_idx" ON "outbound_email" USING btree ("next_attempt_at") WHERE "outbound_email"."status" = 'pending';