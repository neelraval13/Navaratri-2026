-- Guarantees the Drizzle schema DSL cannot express, plus the updated_at
-- trigger. Hand-written on purpose and version controlled like any other
-- migration.

-- `int4range && int4range` needs GiST, and `event_id WITH =` in the same
-- constraint needs btree operator classes inside a GiST index.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- ACTIVE badge ranges within one event may never overlap.
--
-- Desk A #001-#200 and Desk B #150-#300 in the same event is rejected by the
-- database, not merely discouraged by the application: two concurrent writers
-- can both pass an application check and still both commit, and the result is
-- two attendees holding the same physical badge.
--
-- '[]' makes the range inclusive at both ends, matching how the ranges are
-- written down and handed out. The predicate limits the constraint to active
-- rows, so released history never blocks a re-assignment.
ALTER TABLE "badge_assignments"
  ADD CONSTRAINT "badge_assignments_active_ranges_no_overlap"
  EXCLUDE USING gist (
    "event_id" WITH =,
    int4range("range_start", "range_end", '[]') WITH &&
  )
  WHERE ("released_at" IS NULL);
--> statement-breakpoint

-- One generic trigger function for every table carrying updated_at, rather
-- than a per-table implementation. Writers never have to remember the column.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER events_set_updated_at
  BEFORE UPDATE ON "events"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER devices_set_updated_at
  BEFORE UPDATE ON "devices"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TRIGGER badge_assignments_set_updated_at
  BEFORE UPDATE ON "badge_assignments"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
