CREATE TABLE "nda_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nda_template_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "nda_template_body" (
	"version_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"body_md" text NOT NULL,
	"sha256" text NOT NULL,
	CONSTRAINT "nda_template_body_version_id_locale_pk" PRIMARY KEY("version_id","locale")
);
--> statement-breakpoint
CREATE TABLE "nda_template_translation" (
	"template_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "nda_template_translation_template_id_locale_pk" PRIMARY KEY("template_id","locale")
);
--> statement-breakpoint
CREATE TABLE "nda_template_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from" timestamp with time zone,
	"first_accepted_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nda_template_version_number_check" CHECK ("nda_template_version"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "nda_template_body" ADD CONSTRAINT "nda_template_body_version_id_nda_template_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."nda_template_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nda_template_translation" ADD CONSTRAINT "nda_template_translation_template_id_nda_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."nda_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nda_template_version" ADD CONSTRAINT "nda_template_version_template_id_nda_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."nda_template"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nda_template_version_template_idx" ON "nda_template_version" USING btree ("template_id","effective_from");