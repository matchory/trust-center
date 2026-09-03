CREATE TABLE "event_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"audit_seq" bigint NOT NULL,
	"audit_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_delivery_endpoint_seq_key" UNIQUE("endpoint_id","audit_seq"),
	CONSTRAINT "event_delivery_status_check" CHECK ("event_delivery"."status" IN ('pending', 'delivered', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "event_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"format" text NOT NULL,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor_xmin" bigint NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_endpoint_format_check" CHECK ("event_endpoint"."format" IN ('generic', 'teams')),
	CONSTRAINT "event_endpoint_disabled_check" CHECK (("event_endpoint"."enabled" = false) = ("event_endpoint"."disabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "event_endpoint_filter" (
	"endpoint_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	CONSTRAINT "event_endpoint_filter_endpoint_id_pattern_pk" PRIMARY KEY("endpoint_id","pattern")
);
--> statement-breakpoint
ALTER TABLE "event_delivery" ADD CONSTRAINT "event_delivery_endpoint_id_event_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."event_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_endpoint_filter" ADD CONSTRAINT "event_endpoint_filter_endpoint_id_event_endpoint_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."event_endpoint"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_delivery_claim_idx" ON "event_delivery" USING btree ("next_attempt_at") WHERE "event_delivery"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "event_delivery_endpoint_idx" ON "event_delivery" USING btree ("endpoint_id","status") WHERE "event_delivery"."status" = 'pending';