ALTER TYPE "public"."event_kind" ADD VALUE 'born';--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "last_brood_at" timestamp with time zone;