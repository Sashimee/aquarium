ALTER TABLE "tanks" ADD COLUMN "plants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "plant_trim_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;