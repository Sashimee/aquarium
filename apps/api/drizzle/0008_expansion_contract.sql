CREATE TYPE "public"."fish_stage" AS ENUM('fry', 'juvenile', 'adult');--> statement-breakpoint
CREATE TYPE "public"."tank_size" AS ENUM('nano30', 'standard', 'std200', 'long300');--> statement-breakpoint
ALTER TYPE "public"."biome" ADD VALUE 'cichlid';--> statement-breakpoint
ALTER TYPE "public"."biome" ADD VALUE 'blackwater';--> statement-breakpoint
ALTER TYPE "public"."biome" ADD VALUE 'mangrove';--> statement-breakpoint
ALTER TYPE "public"."cause_of_death" ADD VALUE 'nitrite' BEFORE 'old_age';--> statement-breakpoint
ALTER TYPE "public"."cause_of_death" ADD VALUE 'disease' BEFORE 'old_age';--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "stage" "fish_stage" DEFAULT 'adult' NOT NULL;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "personality" jsonb DEFAULT '{"boldness":0.5,"greed":0.5,"sociability":0.5}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "disease" jsonb;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "size" "tank_size" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "quarantine" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "chemistry" jsonb DEFAULT '{"nitrite":0,"ph":7,"kh":4,"temperatureC":25,"salinity":0,"bacteria":{"ammoniaOxidisers":1,"nitriteOxidisers":1}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "equipment" jsonb DEFAULT '{"filter":{"tier":1},"heater":{"tier":0},"light":{"tier":1,"intensity":0.8,"onHour":8,"offHour":20},"co2":{"tier":0},"waveMaker":{"tier":0}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "tanks" ADD CONSTRAINT "tanks_share_token_unique" UNIQUE("share_token");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_handle_unique" UNIQUE("handle");--> statement-breakpoint
UPDATE "tanks" SET "chemistry" = "chemistry" || '{"ph":8.2,"kh":8,"temperatureC":25.5,"salinity":35}'::jsonb WHERE "biome" = 'reef';