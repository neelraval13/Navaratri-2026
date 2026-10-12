-- PHASE D3.3 — BADGELESS DANDIYA ISSUANCE
--
-- A pair may now go out to somebody who has no badge. Three modes:
--
--   two badges            accountability is the two badges
--   one badge + a guest   accountability is that badge
--   two guests            accountability is ONE contact phone number
--
-- APPENDED, and 0000-0005 are untouched: a migration that has run anywhere is
-- history. Every statement here is additive or widening, so EXISTING LOANS ARE
-- PRESERVED EXACTLY — no row is rewritten, moved or deleted.
--
-- `badge_number` BECOMES NULLABLE, and NULL is the truthful representation of
-- "this stick belongs to a guest with no badge". A synthetic `0`, `-1` or
-- `999999` would be a badge number that sorts, matches a search and collides
-- with a real one.
--
-- The positivity CHECK is dropped and re-added WIDENED — `IS NULL OR > 0` —
-- which accepts every value that already exists. Postgres validates the new
-- constraint against the existing rows, and they all pass.
--
-- NULLS ARE DISTINCT IN A UNIQUE INDEX, and both of the holder table's
-- uniqueness rules depend on that now:
--
--   UNIQUE(loan_id, badge_number)                       one loan may hold two
--                                                       guest sticks
--   UNIQUE(event_id, badge_number) WHERE resolved_at IS NULL
--                                                       many unresolved guest
--                                                       sticks may coexist
--
-- Every REAL badge keeps exactly the guarantees it had: a registered attendee
-- still cannot hold two unresolved sticks.
--
-- `contact_phone` IS THE ONLY ATTENDEE-IDENTIFYING VALUE THIS DATABASE HOLDS,
-- and it is deliberate and narrow. Ten digits, the form the rest of the
-- application has always stored, with no `+91` and no spacing. It belongs to
-- the LOAN rather than to a stick, because one of two people leaves a number
-- for the pair. The server writes it ONLY when both holders are badgeless.
--
-- `dandiya_loans_one_open_per_contact` is the badgeless analogue of one
-- unresolved stick per registered attendee. PARTIAL on `closed_at IS NULL`, so
-- the number frees the moment the loan closes — a guest who brought their
-- sticks back may borrow again the same evening, and a historical number never
-- permanently blocks anybody. Badge-based loans carry NULL and never
-- participate in it.
--
-- `accountability_badge_number` IS THE MIXED LOAN'S ANCHOR, and it is why
-- `one badge + one guest` can be said to go out ON THE BADGE.
--
-- The holder-level rule cannot express whole-loan accountability. It is
-- partial on `resolved_at`, so the badge holder is freed the moment their OWN
-- stick is accounted for — correct for a two-badge pair, and wrong for a mixed
-- one: #100 returning their own stick while their guest still holds theirs
-- does not end #100's accountability for that pair, and without this column
-- #100 could immediately anchor another mixed pair.
--
-- So the anchor is a LOAN-level column with its OWN partial unique index,
-- `dandiya_loans_one_open_per_accountability_badge`, partial on
-- `closed_at IS NULL`. The two rules then coexist and mean different things:
-- the holder index says a registered attendee cannot personally hold two
-- unresolved sticks, and this one says a badge cannot anchor two OPEN mixed
-- loans. Once the loan closes — returned, partial_loss or lost — the badge is
-- free again.
--
-- EXACTLY ONE ANCHOR PER LOAN. `dandiya_loans_accountability_exclusive`
-- forbids a contact number and an accountability badge coexisting, so each
-- non-null column means exactly one issuance mode. The FULL relationship to
-- the holder rows — that the anchor is the loan's own sole badge — is the
-- server's, because a CHECK cannot read another table.
--
-- NULLS ARE NON-CONFLICTING here too: two-badge loans and fully badgeless ones
-- carry NULL and never participate in the new index.

ALTER TABLE "dandiya_loan_holders" DROP CONSTRAINT "dandiya_loan_holders_badge_number_positive";--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ALTER COLUMN "badge_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD COLUMN "contact_phone" text;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD COLUMN "accountability_badge_number" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "dandiya_loans_one_open_per_contact" ON "dandiya_loans" USING btree ("event_id","contact_phone") WHERE "dandiya_loans"."closed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "dandiya_loans_one_open_per_accountability_badge" ON "dandiya_loans" USING btree ("event_id","accountability_badge_number") WHERE "dandiya_loans"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_badge_number_positive" CHECK ("dandiya_loan_holders"."badge_number" is null or "dandiya_loan_holders"."badge_number" > 0);--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_contact_phone_canonical" CHECK ("dandiya_loans"."contact_phone" is null or "dandiya_loans"."contact_phone" ~ '^[0-9]{10}$');--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_accountability_badge_positive" CHECK ("dandiya_loans"."accountability_badge_number" is null or "dandiya_loans"."accountability_badge_number" > 0);--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_accountability_exclusive" CHECK ("dandiya_loans"."accountability_badge_number" is null or "dandiya_loans"."contact_phone" is null);