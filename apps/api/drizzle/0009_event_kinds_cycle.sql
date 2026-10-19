ALTER TYPE "public"."event_kind" ADD VALUE 'bottled_bacteria' BEFORE 'ate';--> statement-breakpoint
ALTER TYPE "public"."event_kind" ADD VALUE 'filter_rinse' BEFORE 'ate';--> statement-breakpoint
ALTER TYPE "public"."cause_of_death" ADD VALUE 'water_quality' BEFORE 'old_age';--> statement-breakpoint
ALTER TABLE "tanks" ALTER COLUMN "equipment" SET DEFAULT '{"filter":{"tier":1},"heater":{"tier":1},"light":{"tier":1,"intensity":0.8,"onHour":8,"offHour":20},"co2":{"tier":0},"waveMaker":{"tier":0}}'::jsonb;--> statement-breakpoint
UPDATE "tanks" SET "equipment" = jsonb_set("equipment", '{heater,tier}', '1'::jsonb) WHERE ("equipment"->'heater'->>'tier')::int = 0;