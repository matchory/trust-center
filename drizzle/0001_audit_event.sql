CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"ip" text,
	"ua" text,
	"request_id" text,
	"meta" jsonb
);
--> statement-breakpoint
CREATE INDEX "audit_event_subject_idx" ON "audit_event" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_event_at_idx" ON "audit_event" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_event_actor_idx" ON "audit_event" USING btree ("actor_type","actor_id");