-- CNG MEMBERSHIP — Phase CNG1.
--
-- The event's volunteer group, recorded as a CURATED SUBSET OF THE BADGE
-- REGISTER. A row is a badge NUMBER, the device that added it and when, and
-- that is the entire table.
--
-- APPENDED, and 0000-0006 are untouched: a migration that has run anywhere is
-- history. Every statement here is additive — one new table, its constraints
-- and its two indexes. NO EXISTING TABLE IS ALTERED, no row is rewritten,
-- moved or deleted, and `prize_awards` in particular is not touched at all.
--
-- THERE IS NO NAME COLUMN, and none may be added. The organiser supplies the
-- initial volunteers as NAMES, but a name is not an identity: two attendees
-- may share one, a name may be spelled differently on the day, and a
-- free-text copy here would be a second, unsynchronised record of a person in
-- a database that has held no attendee PII since Phase 9A. Names are resolved
-- to badges in the BROWSER against the live register, and only the badge
-- number is ever sent. No phone, age, gender, WhatsApp link or payment detail
-- has a column here or could have one.
--
-- The person behind the badge is READ from the Google Sheet per request,
-- through the same `server/attendees/register.ts` the prize desk, the
-- attendee directory and the dandiya desk already use. A Sheet row edited
-- away does NOT erase a membership: the row stays and renders as an
-- unavailable attendee, because which badge was added, by which device and
-- when are the ledger's own facts.
--
-- `UNIQUE(event_id, badge_number)` IS THE AUTHORITY, and it is TOTAL rather
-- than partial — unlike the dandiya indexes, which exempt history. A badge
-- either is or is not a member right now, so two desks adding the same
-- volunteer at the same moment cannot produce two rows; the loser is told it
-- was already a member rather than being refused, because the operator asked
-- for a state and that state holds.
--
-- MEMBERSHIP IS MUTABLE, which is the one way it differs from `prize_awards`.
-- A volunteer added by mistake is removed by a human at the desk and the row
-- goes. That removal touches NOTHING else: not the attendee, not a prize
-- award, not a registration. Prize history stays append-only.
--
-- The composite foreign key keeps the same cross-event integrity every other
-- ledger has: a membership cannot be recorded for one event by a device
-- belonging to another.
--
-- Migrations NEVER run automatically. A human runs `pnpm db:migrate`, one
-- environment at a time — Development first, and only after review. See
-- docs/DATABASE.md.

CREATE TABLE "cng_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"badge_number" integer NOT NULL,
	"added_by_device_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cng_members_event_id_badge_number_key" UNIQUE("event_id","badge_number"),
	CONSTRAINT "cng_members_badge_number_positive" CHECK ("cng_members"."badge_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_added_by_device_id_devices_id_fk" FOREIGN KEY ("added_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_device_event_fk" FOREIGN KEY ("added_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cng_members_event_id_idx" ON "cng_members" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "cng_members_added_by_device_id_idx" ON "cng_members" USING btree ("added_by_device_id");