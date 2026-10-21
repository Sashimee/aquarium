ALTER TYPE "public"."event_kind" ADD VALUE 'fish_moved';--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "previous_tank_id" uuid;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "previous_introduced_at" timestamp with time zone;