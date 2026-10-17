-- NAMED CNG MEMBERSHIP, AND A SEPARATE CNG PRIZE LEDGER — Phase CNG1.1.
--
-- 0007 MODELLED A CNG MEMBER AS A BADGE NUMBER, AND THAT WAS WRONG. It
-- assumed a volunteer was a registered attendee who could be found in the
-- Badge Register. They are not: CNG members are event volunteers, they do not
-- wear the numbered attendee badges, and most never pass the registration
-- desk. The only way a badge-keyed membership could represent them is by
-- inventing a badge — and a fake, negative or synthetic number would sort,
-- match a search and collide with a real attendee's.
--
-- 0007 IS NOT EDITED. It has already been applied to Development, and a
-- migration that has run anywhere is history. Production will apply 0007 and
-- then this file; Development applies only this one. 0000-0007 are untouched.
--
-- THIS MIGRATION REFUSES TO RUN IF `cng_members` HAS ANY ROWS. The feature
-- has not been released and Development holds no memberships, so there is
-- nothing to convert — and there is no honest conversion anyway: a badge
-- number is not a name, and silently turning one into the other would invent
-- people. The guard below raises rather than guessing.
--
-- `name` IS NOW THE IDENTITY, AND STORING IT CENTRALLY IS DELIBERATE. This is
-- an explicit, product-required change to the privacy boundary rather than an
-- erosion of it: `name` is the ONE person field this table may hold. No
-- phone, no age, no gender, no WhatsApp link, no payment — none of those are
-- needed to hand somebody a prize, and the Badge Register is not read when a
-- member is added.
--
-- THERE IS NO UNIQUENESS OVER THE NAME, and none may be added. Two volunteers
-- may genuinely share one, and the second person is not a duplicate of the
-- first. The row's UUID is the identity.
--
-- REMOVAL IS SOFT, because `cng_prize_awards` points at these rows and must
-- still be able to name its recipient months later. A member who leaves is
-- marked `removed_at` with the removing device; the ACTIVE roster is
-- `removed_at IS NULL`. `ON DELETE restrict` on the award's foreign key makes
-- a hard delete impossible anyway.
--
-- `prize_awards` IS NOT TOUCHED BY THIS MIGRATION, and that is the point of
-- the separate table. The attendee ledger is Production-live, badge-based and
-- exactly six columns; recording a volunteer's prize there would have meant
-- making `badge_number` nullable, inventing a value for it, or overloading it
-- with an identity it does not describe. It is not named by a single
-- statement below.
--
-- Nothing here touches `events`, `devices`, `device_attributes`,
-- `badge_assignments`, `prize_awards`, `dandiya_loans` or
-- `dandiya_loan_holders` — only `cng_members`, and only to correct a model
-- that has never held a row.
--
-- Migrations NEVER run automatically. A human runs `pnpm db:migrate`, one
-- environment at a time — Development first, and only after review. See
-- docs/DATABASE.md.

-- STATEMENT ORDER IS LOAD-BEARING HERE, AND DRIZZLE DID NOT GET IT RIGHT.
--
-- `cng_prize_awards_member_event_fk` references `cng_members("id","event_id")`,
-- and PostgreSQL requires the referenced column PAIR to already carry a
-- UNIQUE or PRIMARY KEY constraint when the foreign key is created. The
-- primary key on `id` alone does NOT satisfy it. The generated file added
-- that FK BEFORE `cng_members_id_event_id_key`, so the migration would have
-- aborted part-way through with
--
--   there is no unique constraint matching given keys for referenced table
--   "cng_members"
--
-- on every environment, Development included. The statements are therefore
-- ordered by hand: the precondition, the obsolete badge guarantees, the new
-- membership columns, THE REFERENCED UNIQUE KEY, then the award table and
-- only then the composite foreign key. `release:check` asserts that the
-- UNIQUE still appears before the FK, because a regenerate would reintroduce
-- the original order.
--
-- Reordering is all that changed: the set of statements, and therefore the
-- final schema, is identical.

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "cng_members") THEN
		RAISE EXCEPTION 'cng_members is not empty: 0008 changes what a CNG membership MEANS (badge number -> name) and there is no honest conversion. Reconcile these rows by hand before migrating.';
	END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "cng_members" DROP CONSTRAINT "cng_members_event_id_badge_number_key";--> statement-breakpoint
ALTER TABLE "cng_members" DROP CONSTRAINT "cng_members_badge_number_positive";--> statement-breakpoint
ALTER TABLE "cng_members" DROP COLUMN "badge_number";--> statement-breakpoint
ALTER TABLE "cng_members" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "cng_members" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cng_members" ADD COLUMN "removed_by_device_id" uuid;--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_id_event_id_key" UNIQUE("id","event_id");--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_removed_by_device_id_devices_id_fk" FOREIGN KEY ("removed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_removed_device_event_fk" FOREIGN KEY ("removed_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_name_not_empty" CHECK (length(btrim("cng_members"."name")) > 0);--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_name_max_length" CHECK (length("cng_members"."name") <= 120);--> statement-breakpoint
ALTER TABLE "cng_members" ADD CONSTRAINT "cng_members_removal_paired" CHECK (("cng_members"."removed_at" is null) = ("cng_members"."removed_by_device_id" is null));--> statement-breakpoint
CREATE TABLE "cng_prize_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"cng_member_id" uuid NOT NULL,
	"prize_name" text NOT NULL,
	"awarded_by_device_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cng_prize_awards_prize_name_not_empty" CHECK (length(btrim("cng_prize_awards"."prize_name")) > 0),
	CONSTRAINT "cng_prize_awards_prize_name_max_length" CHECK (length("cng_prize_awards"."prize_name") <= 80)
);
--> statement-breakpoint
ALTER TABLE "cng_prize_awards" ADD CONSTRAINT "cng_prize_awards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_prize_awards" ADD CONSTRAINT "cng_prize_awards_cng_member_id_cng_members_id_fk" FOREIGN KEY ("cng_member_id") REFERENCES "public"."cng_members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_prize_awards" ADD CONSTRAINT "cng_prize_awards_awarded_by_device_id_devices_id_fk" FOREIGN KEY ("awarded_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_prize_awards" ADD CONSTRAINT "cng_prize_awards_member_event_fk" FOREIGN KEY ("cng_member_id","event_id") REFERENCES "public"."cng_members"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cng_prize_awards" ADD CONSTRAINT "cng_prize_awards_device_event_fk" FOREIGN KEY ("awarded_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cng_prize_awards_event_id_idx" ON "cng_prize_awards" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "cng_prize_awards_cng_member_id_idx" ON "cng_prize_awards" USING btree ("cng_member_id");--> statement-breakpoint
CREATE INDEX "cng_prize_awards_awarded_by_device_id_idx" ON "cng_prize_awards" USING btree ("awarded_by_device_id");
