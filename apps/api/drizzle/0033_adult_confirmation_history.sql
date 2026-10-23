ALTER TABLE "adult_confirmations" DROP CONSTRAINT "adult_confirmations_pkey";--> statement-breakpoint
ALTER TABLE "adult_confirmations" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE INDEX "adult_confirmations_user_idx" ON "adult_confirmations" USING btree ("user_id","confirmed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "adult_confirmations_open_idx" ON "adult_confirmations" USING btree ("user_id") WHERE "adult_confirmations"."withdrawn_at" is null;