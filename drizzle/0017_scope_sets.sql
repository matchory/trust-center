CREATE TABLE "access_grant_group" (
	"grant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "access_grant_group_grant_id_group_id_pk" PRIMARY KEY("grant_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "access_grant_tier" (
	"grant_id" uuid NOT NULL,
	"tier" text NOT NULL,
	CONSTRAINT "access_grant_tier_grant_id_tier_pk" PRIMARY KEY("grant_id","tier"),
	CONSTRAINT "access_grant_tier_check" CHECK (tier IN ('request', 'nda'))
);
--> statement-breakpoint
CREATE TABLE "access_request_tier" (
	"request_id" uuid NOT NULL,
	"tier" text NOT NULL,
	CONSTRAINT "access_request_tier_request_id_tier_pk" PRIMARY KEY("request_id","tier"),
	CONSTRAINT "access_request_tier_check" CHECK (tier IN ('request', 'nda'))
);
--> statement-breakpoint
CREATE TABLE "access_rule_tier" (
	"rule_id" uuid NOT NULL,
	"tier" text NOT NULL,
	CONSTRAINT "access_rule_tier_rule_id_tier_pk" PRIMARY KEY("rule_id","tier"),
	CONSTRAINT "access_rule_tier_check" CHECK (tier IN ('request', 'nda'))
);
--> statement-breakpoint
ALTER TABLE "access_grant" ADD COLUMN "term_days" integer;--> statement-breakpoint
ALTER TABLE "access_grant_group" ADD CONSTRAINT "access_grant_group_grant_id_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_group" ADD CONSTRAINT "access_grant_group_group_id_access_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."access_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_grant_tier" ADD CONSTRAINT "access_grant_tier_grant_id_access_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."access_grant"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_request_tier" ADD CONSTRAINT "access_request_tier_request_id_access_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."access_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_rule_tier" ADD CONSTRAINT "access_rule_tier_rule_id_access_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."access_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO access_grant_tier (grant_id, tier)
SELECT id, 'request' FROM access_grant WHERE all_request_tier;
--> statement-breakpoint
INSERT INTO access_request_tier (request_id, tier)
SELECT id, 'request' FROM access_request WHERE all_request_tier;
--> statement-breakpoint
-- max_tier is a ceiling, so 'nda' meant "request and nda". Preserving both is
-- what keeps the operator's intent; the application still refuses to honour
-- 'nda' until Phase 3b.
INSERT INTO access_rule_tier (rule_id, tier)
SELECT id, 'request' FROM access_rule WHERE max_tier IN ('request', 'nda');
--> statement-breakpoint
INSERT INTO access_rule_tier (rule_id, tier)
SELECT id, 'nda' FROM access_rule WHERE max_tier = 'nda';
--> statement-breakpoint
-- The term those grants were actually issued under. GREATEST(1, ...) because a
-- grant issued and expiring inside one day would otherwise backfill to zero,
-- and term_days becomes a positive NOT NULL column in Task 9.
UPDATE access_grant
SET term_days = GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - granted_at)) / 86400)::int)
WHERE term_days IS NULL;
