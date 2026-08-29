CREATE TABLE "magic_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"requester_id" uuid,
	"request_id" uuid,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "magic_link_purpose_check" CHECK ("magic_link"."purpose" IN ('verify_request', 'sign_in')),
	CONSTRAINT "magic_link_requester_check" CHECK (("magic_link"."purpose" = 'sign_in') = ("magic_link"."requester_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "requester" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"company" text NOT NULL,
	"company_domain" text NOT NULL,
	"locale" text NOT NULL,
	"notes" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purged_at" timestamp with time zone,
	CONSTRAINT "requester_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "requester_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"requester_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"ua" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requester_session_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_requester_id_requester_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requester"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requester_session" ADD CONSTRAINT "requester_session_requester_id_requester_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requester"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "magic_link_expires_idx" ON "magic_link" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "requester_session_requester_idx" ON "requester_session" USING btree ("requester_id");--> statement-breakpoint
CREATE INDEX "requester_session_expires_idx" ON "requester_session" USING btree ("expires_at");