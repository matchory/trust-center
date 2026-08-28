-- Drizzle's bigserial with mode 'bigint' sets hasDefault but not notNull, so
-- the snapshot disagreed with Postgres, which has always had NOT NULL here.
-- Harmless under `migrate`; a `push` would have tried to DROP NOT NULL.
ALTER TABLE "audit_event" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint

-- Spec section 10: audit_event is append-only, with exactly one exception —
-- pseudonymization on requester purge, which may only CLEAR ip, ua and
-- actor_id. Phase 0 enforced the DELETE half (drizzle/0003) and deliberately
-- left UPDATE alone because the policy did not exist yet.
--
-- Expressing "only toward less identifiability" is only this simple because of
-- the companion invariant: requester personal data appears in audit_event ONLY
-- in these three columns, never in meta and never in subject_id. That is why
-- meta is immutable below rather than redactable.
CREATE FUNCTION "audit_event_forbid_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF NEW."id" IS DISTINCT FROM OLD."id"
		OR NEW."seq" IS DISTINCT FROM OLD."seq"
		OR NEW."at" IS DISTINCT FROM OLD."at"
		OR NEW."actor_type" IS DISTINCT FROM OLD."actor_type"
		OR NEW."action" IS DISTINCT FROM OLD."action"
		OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
		OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
		OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
		OR NEW."meta" IS DISTINCT FROM OLD."meta"
	THEN
		RAISE EXCEPTION 'audit_event is append-only: only ip, ua and actor_id may change';
	END IF;

	IF (NEW."ip" IS NOT NULL AND NEW."ip" IS DISTINCT FROM OLD."ip")
		OR (NEW."ua" IS NOT NULL AND NEW."ua" IS DISTINCT FROM OLD."ua")
		OR (NEW."actor_id" IS NOT NULL AND NEW."actor_id" IS DISTINCT FROM OLD."actor_id")
	THEN
		RAISE EXCEPTION 'audit_event pseudonymization may only clear ip, ua and actor_id, never rewrite them';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_event_forbid_rewrite"
	BEFORE UPDATE ON "audit_event"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_event_forbid_rewrite"();--> statement-breakpoint

-- Row-level DELETE triggers do not fire on TRUNCATE, and the application role
-- owns this table. Phase 0's trigger stops the realistic accident; this closes
-- the hole an auditor would look for.
CREATE FUNCTION "audit_event_forbid_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_event is append-only: the table cannot be truncated';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_event_forbid_truncate"
	BEFORE TRUNCATE ON "audit_event"
	FOR EACH STATEMENT
	EXECUTE FUNCTION "audit_event_forbid_truncate"();--> statement-breakpoint

-- Defence in depth while both tables are still effectively empty. The
-- application already fails closed on an unknown role; this stops a bad value
-- reaching the table at all.
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_type_check"
	CHECK ("actor_type" IN ('staff', 'staff-unresolved', 'requester', 'system'));--> statement-breakpoint

ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_role_check"
	CHECK ("role" IN ('admin', 'approver'));
