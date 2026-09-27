CREATE TABLE "badge_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "badge_assignments_range_start_positive" CHECK ("badge_assignments"."range_start" > 0),
	CONSTRAINT "badge_assignments_range_end_positive" CHECK ("badge_assignments"."range_end" > 0),
	CONSTRAINT "badge_assignments_range_ordered" CHECK ("badge_assignments"."range_start" <= "badge_assignments"."range_end")
);
--> statement-breakpoint
CREATE TABLE "device_attributes" (
	"device_id" uuid NOT NULL,
	"attribute" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_attributes_device_id_attribute_pk" PRIMARY KEY("device_id","attribute"),
	CONSTRAINT "device_attributes_attribute_not_empty" CHECK (length(btrim("device_attributes"."attribute")) > 0)
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"login_name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_id_event_id_key" UNIQUE("id","event_id"),
	CONSTRAINT "devices_name_not_empty" CHECK (length(btrim("devices"."name")) > 0),
	CONSTRAINT "devices_login_name_not_empty" CHECK ("devices"."login_name" is null or length(btrim("devices"."login_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_key" UNIQUE("slug"),
	CONSTRAINT "events_slug_not_empty" CHECK (length(btrim("events"."slug")) > 0),
	CONSTRAINT "events_name_not_empty" CHECK (length(btrim("events"."name")) > 0),
	CONSTRAINT "events_timezone_not_empty" CHECK (length(btrim("events"."timezone")) > 0),
	CONSTRAINT "events_dates_ordered" CHECK ("events"."starts_at" is null or "events"."ends_at" is null or "events"."ends_at" >= "events"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "badge_assignments" ADD CONSTRAINT "badge_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_assignments" ADD CONSTRAINT "badge_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "badge_assignments" ADD CONSTRAINT "badge_assignments_device_event_fk" FOREIGN KEY ("device_id","event_id") REFERENCES "public"."devices"("id","event_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_attributes" ADD CONSTRAINT "device_attributes_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "badge_assignments_event_id_idx" ON "badge_assignments" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "badge_assignments_device_id_idx" ON "badge_assignments" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "badge_assignments_one_active_per_device" ON "badge_assignments" USING btree ("device_id") WHERE "badge_assignments"."released_at" is null;--> statement-breakpoint
CREATE INDEX "device_attributes_device_id_idx" ON "device_attributes" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_event_id_login_name_key" ON "devices" USING btree ("event_id","login_name");--> statement-breakpoint
CREATE INDEX "devices_event_id_idx" ON "devices" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "events_slug_idx" ON "events" USING btree ("slug");