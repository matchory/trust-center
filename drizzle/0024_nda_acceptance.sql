CREATE TABLE "access_grant_acceptance" (
	"grant_id" uuid NOT NULL,
	"acceptance_id" uuid NOT NULL,
	CONSTRAINT "access_grant_acceptance_grant_id_acceptance_id_pk" PRIMARY KEY("grant_id","acceptance_id")
);
--> statement-breakpoint
CREATE TABLE "nda_acceptance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"method" text DEFAULT 'clickthrough' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"ua" text,
	"typed_name" text NOT NULL,
	"email" text NOT NULL,
	"company" text NOT NULL,
	"company_domain" text NOT NULL,
	"template_sha256" text NOT NULL,
	"record_pdf_key" text,
	CONSTRAINT "nda_acceptance_person_version_key" UNIQUE("requester_id","version_id"),
	CONSTRAINT "nda_acceptance_method_check" CHECK ("nda_acceptance"."method" IN ('clickthrough'))
);
--> statement-breakpoint
ALTER TABLE "access_grant_acceptance" ADD CONSTRAINT "access_grant_acceptance_grant_id_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_acceptance" ADD CONSTRAINT "access_grant_acceptance_acceptance_id_nda_acceptance_id_fk" FOREIGN KEY ("acceptance_id") REFERENCES "public"."nda_acceptance"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nda_acceptance" ADD CONSTRAINT "nda_acceptance_requester_id_requester_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."requester"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nda_acceptance" ADD CONSTRAINT "nda_acceptance_version_id_nda_template_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."nda_template_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nda_acceptance_domain_idx" ON "nda_acceptance" USING btree ("company_domain");