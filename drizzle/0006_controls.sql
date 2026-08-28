CREATE TABLE "control" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"group_id" uuid NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_slug_unique" UNIQUE("slug"),
	CONSTRAINT "control_status_check" CHECK ("control"."status" IN ('implemented', 'in_progress', 'planned', 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "control_evidence" (
	"control_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	CONSTRAINT "control_evidence_control_id_document_id_pk" PRIMARY KEY("control_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "control_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "control_group_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "control_group_translation" (
	"group_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	CONSTRAINT "control_group_translation_group_id_locale_pk" PRIMARY KEY("group_id","locale")
);
--> statement-breakpoint
CREATE TABLE "control_translation" (
	"control_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	CONSTRAINT "control_translation_control_id_locale_pk" PRIMARY KEY("control_id","locale")
);
--> statement-breakpoint
ALTER TABLE "control" ADD CONSTRAINT "control_group_id_control_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."control_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_control_id_control_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."control"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_evidence" ADD CONSTRAINT "control_evidence_document_id_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_group_translation" ADD CONSTRAINT "control_group_translation_group_id_control_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."control_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_translation" ADD CONSTRAINT "control_translation_control_id_control_id_fk" FOREIGN KEY ("control_id") REFERENCES "public"."control"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_group_idx" ON "control" USING btree ("group_id");