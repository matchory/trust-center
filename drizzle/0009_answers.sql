CREATE TABLE "answer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"category" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_slug_unique" UNIQUE("slug"),
	CONSTRAINT "answer_visibility_check" CHECK ("answer"."visibility" IN ('public', 'internal'))
);
--> statement-breakpoint
CREATE TABLE "answer_translation" (
	"answer_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	CONSTRAINT "answer_translation_answer_id_locale_pk" PRIMARY KEY("answer_id","locale")
);
--> statement-breakpoint
ALTER TABLE "answer_translation" ADD CONSTRAINT "answer_translation_answer_id_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "public"."answer"("id") ON DELETE cascade ON UPDATE no action;