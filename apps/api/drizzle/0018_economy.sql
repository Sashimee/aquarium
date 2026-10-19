CREATE TYPE "public"."ledger_reason" AS ENUM('purchase', 'earn', 'grant', 'pack', 'subscription', 'refund', 'clawback', 'restore');--> statement-breakpoint
CREATE TYPE "public"."ledger_source" AS ENUM('stripe', 'apple', 'game');--> statement-breakpoint
CREATE TABLE "ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text,
	"delta" integer NOT NULL,
	"reason" "ledger_reason" NOT NULL,
	"source" "ledger_source" NOT NULL,
	"item_ref" text,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_delta_nonzero" CHECK ("ledger"."delta" <> 0),
	CONSTRAINT "ledger_game_has_user" CHECK ("ledger"."source" <> 'game' or "ledger"."user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "wallet" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet" ADD CONSTRAINT "wallet_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_payment_key_idx" ON "ledger" USING btree ("source","idempotency_key") WHERE "ledger"."source" <> 'game';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_play_key_idx" ON "ledger" USING btree ("user_id","idempotency_key") WHERE "ledger"."source" = 'game';--> statement-breakpoint
CREATE INDEX "ledger_user_id_created_at_idx" ON "ledger" USING btree ("user_id","created_at");
--> statement-breakpoint
INSERT INTO "wallet" ("user_id", "balance") SELECT "id", 1000 FROM "user";--> statement-breakpoint
INSERT INTO "ledger" ("user_id", "delta", "reason", "source", "item_ref", "idempotency_key")
SELECT "id", 1000, 'grant', 'game', 'grant:migration', 'grant-migration' FROM "user";
