CREATE TABLE "audit_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cursor_xmin" bigint NOT NULL,
	"cursor_seq" bigint NOT NULL,
	"prev_cursor_xmin" bigint NOT NULL,
	"prev_cursor_seq" bigint NOT NULL,
	"row_count" integer NOT NULL,
	"min_seq" bigint NOT NULL,
	"max_seq" bigint NOT NULL,
	"byte_count" integer NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "audit_batch_cursor_key" UNIQUE("cursor_xmin","cursor_seq")
);
--> statement-breakpoint
CREATE TABLE "audit_batch_shipment" (
	"batch_id" uuid NOT NULL,
	"sink" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_status_code" integer,
	"shipped_at" timestamp with time zone,
	"object_key" text,
	"digest" text,
	CONSTRAINT "audit_batch_shipment_batch_id_sink_pk" PRIMARY KEY("batch_id","sink")
);
--> statement-breakpoint
ALTER TABLE "audit_batch_shipment" ADD CONSTRAINT "audit_batch_shipment_batch_id_audit_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."audit_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_batch_created_idx" ON "audit_batch" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_batch_shipment_claim_idx" ON "audit_batch_shipment" USING btree ("sink","next_attempt_at") WHERE "audit_batch_shipment"."shipped_at" IS NULL;
--> statement-breakpoint
-- Spec §2.1: the batch table is the cursor, which makes it a control surface
-- as well as evidence. One forged INSERT with a high cursor would silently
-- skip a window of the audit log. These triggers raise the cost; the
-- attestation object (§3.4) is what survives an actor who can drop them.
CREATE FUNCTION "audit_batch_forbid_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_batch is append-only';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_forbid_change"
	BEFORE UPDATE OR DELETE ON "audit_batch"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_forbid_change"();--> statement-breakpoint

CREATE FUNCTION "audit_batch_forbid_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_batch is append-only: the table cannot be truncated';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_forbid_truncate"
	BEFORE TRUNCATE ON "audit_batch"
	FOR EACH STATEMENT
	EXECUTE FUNCTION "audit_batch_forbid_truncate"();--> statement-breakpoint

-- Spec §2.1, §2.4: a new batch must continue the chain. This is what turns a
-- restore, an xid wraparound or a forged row into a loud failure instead of a
-- silently skipped window — and it is why re-seeding after a restore is an
-- INSERT that moves forward, never a DELETE (spec §12).
CREATE FUNCTION "audit_batch_require_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	max_xmin bigint;
	max_seq bigint;
BEGIN
	SELECT b."cursor_xmin", b."cursor_seq" INTO max_xmin, max_seq
	FROM "audit_batch" b
	ORDER BY b."cursor_xmin" DESC, b."cursor_seq" DESC
	LIMIT 1;

	IF max_xmin IS NULL THEN
		max_xmin := 0;
		max_seq := 0;
	END IF;

	IF (NEW."prev_cursor_xmin", NEW."prev_cursor_seq") IS DISTINCT FROM (max_xmin, max_seq) THEN
		RAISE EXCEPTION 'audit_batch cursor chain broken: prev (%,%) does not match current head (%,%)',
			NEW."prev_cursor_xmin", NEW."prev_cursor_seq", max_xmin, max_seq;
	END IF;

	IF (NEW."cursor_xmin", NEW."cursor_seq") <= (max_xmin, max_seq) THEN
		RAISE EXCEPTION 'audit_batch cursor must advance: (%,%) is not above (%,%)',
			NEW."cursor_xmin", NEW."cursor_seq", max_xmin, max_seq;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_require_monotonic"
	BEFORE INSERT ON "audit_batch"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_require_monotonic"();--> statement-breakpoint

-- Shipments record progress, so UPDATE is permitted — but only of the progress
-- columns, and the row may never be removed.
CREATE FUNCTION "audit_batch_shipment_forbid_rewrite"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'audit_batch_shipment is append-only';
	END IF;

	IF NEW."batch_id" IS DISTINCT FROM OLD."batch_id"
		OR NEW."sink" IS DISTINCT FROM OLD."sink"
	THEN
		RAISE EXCEPTION 'audit_batch_shipment identity may not change';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_shipment_forbid_rewrite"
	BEFORE UPDATE OR DELETE ON "audit_batch_shipment"
	FOR EACH ROW
	EXECUTE FUNCTION "audit_batch_shipment_forbid_rewrite"();--> statement-breakpoint

-- A row-level DELETE trigger does not fire on TRUNCATE, and the application
-- role owns this table like it owns audit_batch — so the row-level guard
-- above closes UPDATE/DELETE but leaves TRUNCATE open, exactly the gap
-- drizzle/0004's statement-level trigger closes for audit_event (spec §2.1).
CREATE FUNCTION "audit_batch_shipment_forbid_truncate"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_batch_shipment is append-only: the table cannot be truncated';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "audit_batch_shipment_forbid_truncate"
	BEFORE TRUNCATE ON "audit_batch_shipment"
	FOR EACH STATEMENT
	EXECUTE FUNCTION "audit_batch_shipment_forbid_truncate"();--> statement-breakpoint

-- Defence in depth, same reasoning as audit_event_actor_type_check
-- (drizzle/0004): a stale or misspelled sink name from job wiring would
-- otherwise create a pending shipment row no adapter ever claims, in a table
-- that forbids DELETE and is excluded from retention (spec §12).
ALTER TABLE "audit_batch_shipment" ADD CONSTRAINT "audit_batch_shipment_sink_check"
	CHECK ("sink" IN ('s3', 'syslog'));