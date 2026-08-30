ALTER TABLE "access_rule" DROP CONSTRAINT "access_rule_max_tier_check";--> statement-breakpoint
ALTER TABLE "access_grant" ALTER COLUMN "term_days" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grant" DROP COLUMN "all_request_tier";--> statement-breakpoint
ALTER TABLE "access_request" DROP COLUMN "all_request_tier";--> statement-breakpoint
ALTER TABLE "access_rule" DROP COLUMN "max_tier";--> statement-breakpoint
ALTER TABLE "access_grant" ADD CONSTRAINT "access_grant_term_days_check" CHECK ("access_grant"."term_days" >= 1);