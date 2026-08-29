CREATE TABLE "access_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"request_id" uuid,
	"all_request_tier" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_staff_id" uuid,
	"expiry_reminder_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_grant_document" (
	"grant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "access_grant_document_grant_id_document_id_pk" PRIMARY KEY("grant_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "access_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"status" text DEFAULT 'unverified' NOT NULL,
	"all_request_tier" boolean DEFAULT false NOT NULL,
	"justification" text,
	"source" text DEFAULT 'portal' NOT NULL,
	"submitted_email" text,
	"submitted_name" text,
	"submitted_company" text,
	"decided_by_staff_id" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_request_status_check" CHECK ("access_request"."status" IN ('unverified', 'pending', 'info_requested', 'approved', 'denied')),
	CONSTRAINT "access_request_source_check" CHECK ("access_request"."source" IN ('portal', 'invite')),
	CONSTRAINT "access_request_verification_check" CHECK (CASE WHEN "access_request"."status" = 'unverified'
			         THEN "access_request"."requester_id" IS NULL AND "access_request"."submitted_email" IS NOT NULL
			         ELSE "access_request"."requester_id" IS NOT NULL AND "access_request"."submitted_email" IS NULL
			    END)
);
--> statement-breakpoint
CREATE TABLE "access_request_document" (
	"request_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "access_request_document_request_id_document_id_pk" PRIMARY KEY("request_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "access_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"max_tier" text DEFAULT 'request' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_rule_action_check" CHECK ("access_rule"."action" IN ('auto_approve', 'review', 'deny')),
	CONSTRAINT "access_rule_max_tier_check" CHECK ("access_rule"."max_tier" IN ('public', 'request', 'nda'))
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_requester_id_requester_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requester"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_request_id_access_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_request"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_revoked_by_staff_id_staff_user_id_fk" FOREIGN KEY ("revoked_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_document" ADD CONSTRAINT "access_grant_document_grant_id_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_document" ADD CONSTRAINT "access_grant_document_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_requester_id_requester_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requester"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request" ADD CONSTRAINT "access_request_decided_by_staff_id_staff_user_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request_document" ADD CONSTRAINT "access_request_document_request_id_access_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request_document" ADD CONSTRAINT "access_request_document_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grant_requester_idx" ON "access_grant" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "access_grant_expires_idx" ON "access_grant" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "access_request_status_idx" ON "access_request" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "access_request_requester_idx" ON "access_request" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "access_rule_priority_idx" ON "access_rule" USING btree ("priority");--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_request_id_access_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_request"("id") ON DELETE cascade ON UPDATE no action;