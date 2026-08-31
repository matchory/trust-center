ALTER TABLE "access_grant" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "acceptance_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "acceptance_reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_inert_check" CHECK ("access_grant"."expires_at" IS NOT NULL OR "access_grant"."acceptance_due_at" IS NOT NULL);