CREATE TABLE "update_post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "update_post_slug_unique" UNIQUE("slug"),
	CONSTRAINT "update_post_kind_check" CHECK ("update_post"."kind" IN ('document', 'subprocessor', 'certification', 'advisory'))
);
--> statement-breakpoint
CREATE TABLE "update_post_translation" (
	"post_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "update_post_translation_post_id_locale_pk" PRIMARY KEY("post_id","locale")
);
--> statement-breakpoint
ALTER TABLE "update_post_translation" ADD CONSTRAINT "update_post_translation_post_id_update_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."update_post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "update_post_published_idx" ON "update_post" USING btree ("published_at");