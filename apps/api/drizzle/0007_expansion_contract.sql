CREATE TYPE "public"."fish_stage" AS ENUM('fry', 'juvenile', 'adult');--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "stage" "fish_stage" DEFAULT 'adult' NOT NULL;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "personality" jsonb DEFAULT '{"boldness":0.5,"greed":0.5,"sociability":0.5}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "disease" jsonb;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "chemistry" jsonb DEFAULT '{"nitrite":0,"ph":7,"kh":4,"temperatureC":25,"bacteria":{"ammoniaOxidisers":0,"nitriteOxidisers":0}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "equipment" jsonb DEFAULT '{"filter":{"tier":1},"heater":{"tier":0},"light":{"tier":1,"intensity":0.8,"onHour":8,"offHour":20},"co2":{"tier":0},"waveMaker":{"tier":0}}'::jsonb NOT NULL;--> statement-breakpoint
-- Tanks that exist now were running before chemistry v2, so they start with established colonies. New tanks keep the uncycled default.
UPDATE "tanks" SET "chemistry" = jsonb_set("chemistry", '{bacteria}', '{"ammoniaOxidisers":1,"nitriteOxidisers":1}'::jsonb);
