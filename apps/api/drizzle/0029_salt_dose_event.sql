ALTER TYPE "public"."event_kind" ADD VALUE 'salt_dose';
--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'buffer_dose';
--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'add_botanicals';
--> statement-breakpoint
ALTER TABLE "tanks" ALTER COLUMN "water" SET DEFAULT '{"ammonia":0,"nitrate":0,"algae":0,"uneatenFood":0,"tannin":0}'::jsonb;
--> statement-breakpoint
UPDATE "tanks" SET "water" = "water" || '{"tannin":0}'::jsonb WHERE NOT ("water" ? 'tannin');
