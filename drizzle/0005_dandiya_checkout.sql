-- DANDIYA CHECKOUT AND RETURN — Phase D3.
--
-- A physical dandiya PAIR goes out to exactly two registered attendees and
-- stays out until somebody returns it. That repeats all evening and across
-- event days, so every table here is append-and-close rather than
-- create-and-destroy: a returned loan is history, and the same pair goes out
-- again tomorrow.
--
-- EACH STICK MOVES INDEPENDENTLY — Phase D3.1. A holder row carries its own
-- resolution (`returned` or `lost`), so one stick may come back while the
-- other stays out. The loan closes only when neither is unresolved, and its
-- outcome is DERIVED from the two: two returns are `returned`, one loss is a
-- `partial_loss`, two losses are `lost`.
--
-- TWO PARTIAL UNIQUE INDEXES ARE THE ENTIRE CONCURRENCY STORY:
--
--   dandiya_loan_holders_one_unresolved_per_badge
--     UNIQUE(event_id, badge_number) WHERE resolved_at IS NULL
--
--     One unresolved stick per attendee. Partial on `resolved_at`, not on the
--     resolution, because a stick that was LOST frees its holder exactly as a
--     returned one does — and without waiting for the other holder.
--
--   dandiya_loans_one_unreleased_per_pair
--     UNIQUE(event_id, pair_code) WHERE pair_released_at IS NULL
--
--     One unavailable loan per physical pair. `pair_released_at` is set ONLY
--     by a clean return, so the slot is occupied by an OPEN loan AND by a
--     CLOSED loan that lost a stick. That single null is the quarantine:
--     there is deliberately no pair-inventory table, and only a future
--     explicit Restore Pair workflow would clear it.
--
-- Both are PARTIAL on purpose. Uniqueness that also covered history would
-- forbid exactly the reuse the event depends on — one pair cannot be out
-- twice at once, but a cleanly returned pair can go out fifty times in an
-- evening. No application check can replace them: two desks can each read
-- "this pair is free" and both submit, and only the database decides.
--
-- THE PAIR IS FREED BY A CLEAN RETURN AND BY NOTHING ELSE, enforced in both
-- directions: `dandiya_loans_release_requires_returned` forbids a release
-- without `outcome = 'returned'`, and `dandiya_loans_returned_requires_release`
-- forbids a clean return without one. A loss can never quietly free the pair,
-- and a clean return can never quietly keep it.
--
-- NOTHING HERE EXPIRES. A stick is resolved by a person and by nothing else.
-- There is no timer, no nightly job and no date arithmetic in this schema: a
-- pair still out from yesterday is still out, and midnight changes only which
-- rows a screen calls "today".
--
-- HOLDERS ARE ROWS, NOT COLUMNS. Two rows per loan, one per stick-slot,
-- because the active-attendee guarantee has to be a unique index over a
-- single badge column — with `badge_one` and `badge_two` columns no index
-- could stop the same attendee appearing as badge_one here and badge_two
-- there. D3.1 makes the shape earn its keep twice over: a per-row resolution
-- is what lets one stick come back while the other stays out.
--
-- EVERY PERSISTED PAIR CODE IS CANONICAL: trimmed, then uppercased, which
-- `dandiya_loans_pair_code_canonical` enforces. That is a SAFETY rule rather
-- than tidiness. The partial unique index compares bytes, so `D-014` and
-- `d-014` stored as typed would be two open loans on one set of sticks — two
-- volunteers with different shift keys would each believe they had the pair.
-- Canonicalising before the insert is what makes the index mean what it says.
--
-- NO ATTENDEE PII. A loan records a pair code, two badge NUMBERS and two
-- device ids. No name, phone, age, gender, WhatsApp link or payment column
-- exists in either table, and none may be added: the person behind a badge
-- stays in the Google Sheet, which the Dandiya screen joins per request.
--
-- 0000-0004 ARE NOT EDITED. They have been applied, and a migration that has
-- run anywhere is history.
--
-- Migrations NEVER run automatically. A human runs `pnpm db:migrate`, one
-- environment at a time. See docs/DATABASE.md.

CREATE TABLE "dandiya_loan_holders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"loan_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"badge_number" integer NOT NULL,
	"slot" smallint NOT NULL,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_device_id" uuid,
	CONSTRAINT "dandiya_loan_holders_loan_id_slot_key" UNIQUE("loan_id","slot"),
	CONSTRAINT "dandiya_loan_holders_loan_id_badge_number_key" UNIQUE("loan_id","badge_number"),
	CONSTRAINT "dandiya_loan_holders_badge_number_positive" CHECK ("dandiya_loan_holders"."badge_number" > 0),
	CONSTRAINT "dandiya_loan_holders_slot_valid" CHECK ("dandiya_loan_holders"."slot" in (1, 2)),
	CONSTRAINT "dandiya_loan_holders_resolution_paired" CHECK (("dandiya_loan_holders"."resolution" is null) = ("dandiya_loan_holders"."resolved_at" is null)
          and ("dandiya_loan_holders"."resolution" is null) = ("dandiya_loan_holders"."resolved_by_device_id" is null)),
	CONSTRAINT "dandiya_loan_holders_resolution_valid" CHECK ("dandiya_loan_holders"."resolution" is null or "dandiya_loan_holders"."resolution" in ('returned', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "dandiya_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"pair_code" text NOT NULL,
	"issued_by_device_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_device_id" uuid,
	"outcome" text,
	"pair_released_at" timestamp with time zone,
	CONSTRAINT "dandiya_loans_id_event_id_key" UNIQUE("id","event_id"),
	CONSTRAINT "dandiya_loans_pair_code_not_empty" CHECK (length(btrim("dandiya_loans"."pair_code")) > 0),
	CONSTRAINT "dandiya_loans_pair_code_max_length" CHECK (length("dandiya_loans"."pair_code") <= 32),
	CONSTRAINT "dandiya_loans_pair_code_canonical" CHECK ("dandiya_loans"."pair_code" = upper(btrim("dandiya_loans"."pair_code"))),
	CONSTRAINT "dandiya_loans_close_paired" CHECK (("dandiya_loans"."closed_at" is null) = ("dandiya_loans"."outcome" is null)
          and ("dandiya_loans"."closed_at" is null) = ("dandiya_loans"."closed_by_device_id" is null)),
	CONSTRAINT "dandiya_loans_outcome_valid" CHECK ("dandiya_loans"."outcome" is null or "dandiya_loans"."outcome" in ('returned', 'partial_loss', 'lost')),
	CONSTRAINT "dandiya_loans_release_requires_returned" CHECK ("dandiya_loans"."pair_released_at" is null or "dandiya_loans"."outcome" = 'returned'),
	CONSTRAINT "dandiya_loans_returned_requires_release" CHECK ("dandiya_loans"."outcome" is distinct from 'returned' or "dandiya_loans"."pair_released_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_loan_id_dandiya_loans_id_fk" FOREIGN KEY ("loan_id") REFERENCES "public"."dandiya_loans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_resolved_by_device_id_devices_id_fk" FOREIGN KEY ("resolved_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_loan_event_fk" FOREIGN KEY ("loan_id","event_id") REFERENCES "public"."dandiya_loans"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loan_holders" ADD CONSTRAINT "dandiya_loan_holders_resolved_device_event_fk" FOREIGN KEY ("resolved_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_issued_by_device_id_devices_id_fk" FOREIGN KEY ("issued_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_closed_by_device_id_devices_id_fk" FOREIGN KEY ("closed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_issued_device_event_fk" FOREIGN KEY ("issued_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dandiya_loans" ADD CONSTRAINT "dandiya_loans_closed_device_event_fk" FOREIGN KEY ("closed_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dandiya_loan_holders_one_unresolved_per_badge" ON "dandiya_loan_holders" USING btree ("event_id","badge_number") WHERE "dandiya_loan_holders"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "dandiya_loan_holders_loan_id_idx" ON "dandiya_loan_holders" USING btree ("loan_id");--> statement-breakpoint
CREATE INDEX "dandiya_loan_holders_event_id_idx" ON "dandiya_loan_holders" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dandiya_loans_one_unreleased_per_pair" ON "dandiya_loans" USING btree ("event_id","pair_code") WHERE "dandiya_loans"."pair_released_at" is null;--> statement-breakpoint
CREATE INDEX "dandiya_loans_event_id_idx" ON "dandiya_loans" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "dandiya_loans_issued_by_device_id_idx" ON "dandiya_loans" USING btree ("issued_by_device_id");