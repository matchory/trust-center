ALTER TABLE "audit_event" ADD COLUMN "seq" bigserial;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_seq_unique" UNIQUE("seq");--> statement-breakpoint
-- audit_event is append-only: enforce it at the database, not just in the
-- application (src/lib/server/audit/index.ts exposes no update/delete
-- helpers, but that convention alone can't stop a future call site or a
-- direct SQL statement from deleting rows). UPDATE is deliberately left
-- alone: the spec requires audit events be pseudonymized on requester
-- purge, and that policy doesn't exist yet — it belongs with the purge path
-- in a later phase. A trigger is used instead of a revoked GRANT because
-- drizzle-kit migrate runs as the same Postgres role as the application in
-- this deployment shape, so revoking DELETE from that role would also break
-- migrations.
CREATE FUNCTION "audit_event_forbid_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_event is append-only: rows cannot be deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_event_forbid_delete"
	BEFORE DELETE ON "audit_event"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_event_forbid_delete"();