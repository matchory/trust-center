CREATE TABLE "access_grant_nda" (
	"grant_id" uuid NOT NULL,
	"nda_template_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"decided_by_staff_id" uuid,
	"reason" text,
	CONSTRAINT "access_grant_nda_grant_id_nda_template_id_pk" PRIMARY KEY("grant_id","nda_template_id"),
	CONSTRAINT "access_grant_nda_disposition_check" CHECK ("access_grant_nda"."disposition" IN ('required', 'waived'))
);
--> statement-breakpoint
ALTER TABLE "access_grant_nda" ADD CONSTRAINT "access_grant_nda_grant_id_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_nda" ADD CONSTRAINT "access_grant_nda_nda_template_id_nda_template_id_fk" FOREIGN KEY ("nda_template_id") REFERENCES "public"."nda_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_nda" ADD CONSTRAINT "access_grant_nda_decided_by_staff_id_staff_user_id_fk" FOREIGN KEY ("decided_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;