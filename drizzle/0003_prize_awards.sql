-- THE PRIZE LEDGER — Phase P1.
--
-- Postgres records which badge received which prize, from which device, and
-- when. It records NOTHING about the person: no name, phone, age, gender,
-- WhatsApp link or payment. Those stay in the Google Sheet, which the prize
-- screen joins per request, so the central database keeps the property it has
-- had since Phase 9A — no attendee PII.
--
-- UNIQUE(event_id, badge_number) is the real guarantee that one attendee
-- receives at most one prize. Two prize desks can both see a badge as
-- eligible and both submit; the constraint decides, and no application check
-- above it could.
--
-- APPEND-ONLY from the product: no undo, no delete, no edit. There is
-- therefore no updated_at column and deliberately no set_updated_at trigger —
-- awarded_at is the only timestamp that means anything here.
--
-- Migrations NEVER run automatically. A human runs `pnpm db:migrate`, one
-- environment at a time. See docs/DATABASE.md.

CREATE TABLE "prize_awards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"badge_number" integer NOT NULL,
	"prize_name" text NOT NULL,
	"awarded_by_device_id" uuid NOT NULL,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prize_awards_event_id_badge_number_key" UNIQUE("event_id","badge_number"),
	CONSTRAINT "prize_awards_badge_number_positive" CHECK ("prize_awards"."badge_number" > 0),
	CONSTRAINT "prize_awards_prize_name_not_empty" CHECK (length(btrim("prize_awards"."prize_name")) > 0),
	CONSTRAINT "prize_awards_prize_name_max_length" CHECK (length("prize_awards"."prize_name") <= 80)
);
--> statement-breakpoint
ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_awarded_by_device_id_devices_id_fk" FOREIGN KEY ("awarded_by_device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prize_awards" ADD CONSTRAINT "prize_awards_device_event_fk" FOREIGN KEY ("awarded_by_device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prize_awards_event_id_idx" ON "prize_awards" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "prize_awards_awarded_by_device_id_idx" ON "prize_awards" USING btree ("awarded_by_device_id");
