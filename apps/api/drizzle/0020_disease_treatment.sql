ALTER TABLE "fish" ADD COLUMN "introduced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "medicine" jsonb;