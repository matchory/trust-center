CREATE TABLE "access_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_group_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "access_group_translation" (
	"group_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "access_group_translation_group_id_locale_pk" PRIMARY KEY("group_id","locale")
);
--> statement-breakpoint
CREATE TABLE "document_group" (
	"document_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "document_group_document_id_group_id_pk" PRIMARY KEY("document_id","group_id")
);
--> statement-breakpoint
ALTER TABLE "access_group_translation" ADD CONSTRAINT "access_group_translation_group_id_access_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_group" ADD CONSTRAINT "document_group_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_group" ADD CONSTRAINT "document_group_group_id_access_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_group_group_idx" ON "document_group" USING btree ("group_id");