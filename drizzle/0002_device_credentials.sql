ALTER TABLE "devices" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_password_hash_not_empty" CHECK ("devices"."password_hash" is null or length(btrim("devices"."password_hash")) > 0);--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_session_version_positive" CHECK ("devices"."session_version" >= 1);