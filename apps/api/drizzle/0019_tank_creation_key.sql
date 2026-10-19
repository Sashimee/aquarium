ALTER TABLE "tanks" ADD COLUMN "creation_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tanks_owner_creation_key_idx" ON "tanks" USING btree ("owner_id","creation_key") WHERE "tanks"."creation_key" is not null;--> statement-breakpoint
UPDATE "ledger" SET "idempotency_key" = 'server:' || "idempotency_key"
WHERE "source" = 'game' AND "reason" IN ('earn', 'grant') AND "idempotency_key" <> 'grant-migration'
  AND "idempotency_key" NOT LIKE 'server:%';
