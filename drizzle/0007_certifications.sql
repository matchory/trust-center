CREATE TABLE "certification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"framework" text NOT NULL,
	"issuer" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"certificate_document_id" uuid,
	"published" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certification_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "certification_translation" (
	"certification_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"scope" text NOT NULL,
	CONSTRAINT "certification_translation_certification_id_locale_pk" PRIMARY KEY("certification_id","locale")
);
--> statement-breakpoint
ALTER TABLE "certification" ADD CONSTRAINT "certification_certificate_document_id_document_id_fk" FOREIGN KEY ("certificate_document_id") REFERENCES "public"."document"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification_translation" ADD CONSTRAINT "certification_translation_certification_id_certification_id_fk" FOREIGN KEY ("certification_id") REFERENCES "public"."certification"("id") ON DELETE cascade ON UPDATE no action;