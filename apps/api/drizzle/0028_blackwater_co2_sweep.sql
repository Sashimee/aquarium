-- Second pass of 0027 for CO2 sold by an old container during the rolling deploy, after 0027 ran.
-- 0027 zeroed every blackwater CO2 tier, so any tier above 0 found now can only come from that window.
-- Refund = list price of the installed tier (300 / 700). The ledger has no per-tank purchase
-- record, so a cumulative refund for tier 1 then tier 2 (1000) cannot be told from tier 2 bought
-- directly (700); the list price never over-refunds.
-- Ledger key is server:-namespaced (clients cannot send ':'), unlike 0018 and 0027, which stay as
-- they are because their keys are already stored and renaming them would invite a double refund.
-- Refunds go only to existing wallets, because a row created here would stop lockWallet from ever
-- granting that user the starting balance. Buying CO2 needs a wallet, so a walletless owner has
-- nothing to get back and the tank is reset without a refund.
CREATE TEMP TABLE "blackwater_co2_swept" ON COMMIT DROP AS
SELECT "id", "owner_id", ("equipment"->'co2'->>'tier')::int AS "tier"
FROM "tanks"
WHERE "biome" = 'blackwater' AND ("equipment"->'co2'->>'tier')::int > 0;--> statement-breakpoint
WITH "refunds" AS (
	INSERT INTO "ledger" ("user_id", "delta", "reason", "source", "item_ref", "idempotency_key")
	SELECT "s"."owner_id",
		CASE "s"."tier" WHEN 1 THEN 300 ELSE 700 END,
		'grant', 'game', 'grant:co2-removed-from-blackwater', 'server:co2-sweep-' || "s"."id"
	FROM "blackwater_co2_swept" "s"
	WHERE "s"."tier" IN (1, 2) AND EXISTS (SELECT 1 FROM "wallet" "w" WHERE "w"."user_id" = "s"."owner_id")
	ON CONFLICT ("user_id", "idempotency_key") WHERE "source" = 'game' DO NOTHING
	RETURNING "user_id", "delta"
),
"totals" AS (
	SELECT "user_id", SUM("delta") AS "total" FROM "refunds" GROUP BY "user_id"
)
UPDATE "wallet" SET "balance" = "wallet"."balance" + "totals"."total"
FROM "totals" WHERE "wallet"."user_id" = "totals"."user_id";--> statement-breakpoint
UPDATE "tanks" SET "equipment" = jsonb_set("equipment", '{co2,tier}', '0'::jsonb)
WHERE "id" IN (SELECT "id" FROM "blackwater_co2_swept");
