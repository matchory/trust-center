CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"category_id" uuid NOT NULL,
	"tier" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_slug_unique" UNIQUE("slug"),
	CONSTRAINT "document_tier_check" CHECK ("document"."tier" IN ('public', 'request', 'nda')),
	CONSTRAINT "document_status_check" CHECK ("document"."status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "document_category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_category_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "document_category_translation" (
	"category_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "document_category_translation_category_id_locale_pk" PRIMARY KEY("category_id","locale")
);
--> statement-breakpoint
CREATE TABLE "document_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"version" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"uploaded_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_translation" (
	"document_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	CONSTRAINT "document_translation_document_id_locale_pk" PRIMARY KEY("document_id","locale")
);
--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_category_id_document_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."document_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_category_translation" ADD CONSTRAINT "document_category_translation_category_id_document_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."document_category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_file" ADD CONSTRAINT "document_file_uploaded_by_staff_id_staff_user_id_fk" FOREIGN KEY ("uploaded_by_staff_id") REFERENCES "public"."staff_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_translation" ADD CONSTRAINT "document_translation_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_category_idx" ON "document" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_file_version_idx" ON "document_file" USING btree ("document_id","locale","version");--> statement-breakpoint
CREATE UNIQUE INDEX "document_file_current_idx" ON "document_file" USING btree ("document_id","locale") WHERE "document_file"."is_current";