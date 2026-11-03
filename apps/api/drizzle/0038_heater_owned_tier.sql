ALTER TABLE "tanks" ADD COLUMN "heater_owned_tier" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
UPDATE "tanks" SET "heater_owned_tier" = ("equipment"->'heater'->>'tier')::int;
