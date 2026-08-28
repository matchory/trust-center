CREATE TABLE "subprocessor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"legal_entity" text NOT NULL,
	"country" text NOT NULL,
	"region" text NOT NULL,
	"hosting_provider" text,
	"dpa_url" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"published" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subprocessor_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "subprocessor_translation" (
	"subprocessor_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"purpose" text NOT NULL,
	"data_categories" text NOT NULL,
	CONSTRAINT "subprocessor_translation_subprocessor_id_locale_pk" PRIMARY KEY("subprocessor_id","locale")
);
--> statement-breakpoint
ALTER TABLE "subprocessor_translation" ADD CONSTRAINT "subprocessor_translation_subprocessor_id_subprocessor_id_fk" FOREIGN KEY ("subprocessor_id") REFERENCES "public"."subprocessor"("id") ON DELETE cascade ON UPDATE no action;