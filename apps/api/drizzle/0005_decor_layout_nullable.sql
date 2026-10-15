ALTER TABLE "tanks" ALTER COLUMN "decor_layout" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "tanks" ALTER COLUMN "decor_layout" DROP NOT NULL;--> statement-breakpoint
UPDATE "tanks" SET "decor_layout" = NULL WHERE "decor_layout" = '[]'::jsonb;
