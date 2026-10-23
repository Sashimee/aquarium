ALTER TABLE "tanks" ADD COLUMN "co2_owned_tier" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "tanks" SET "co2_owned_tier" = ("equipment"->'co2'->>'tier')::int;
