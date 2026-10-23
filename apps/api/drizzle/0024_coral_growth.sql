ALTER TABLE "tanks" ADD COLUMN "corals" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "coral_frag_keys" jsonb DEFAULT '[]'::jsonb NOT NULL;