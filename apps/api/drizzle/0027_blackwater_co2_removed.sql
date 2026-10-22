CREATE TEMP TABLE "blackwater_co2_removed" ON COMMIT DROP AS
SELECT "id", "owner_id", ("equipment"->'co2'->>'tier')::int AS "tier"
FROM "tanks"
WHERE "biome" = 'blackwater' AND ("equipment"->'co2'->>'tier')::int > 0;--> statement-breakpoint
WITH "refunds" AS (
	INSERT INTO "ledger" ("user_id", "delta", "reason", "source", "item_ref", "idempotency_key")
	SELECT "owner_id",
		CASE "tier" WHEN 1 THEN 300 ELSE 700 END,
		'grant', 'game', 'grant:co2-removed-from-blackwater', 'co2-removed-from-blackwater-' || "id"
	FROM "blackwater_co2_removed"
	WHERE "tier" IN (1, 2)
	ON CONFLICT ("user_id", "idempotency_key") WHERE "source" = 'game' DO NOTHING
	RETURNING "user_id", "delta"
)
INSERT INTO "wallet" ("user_id", "balance")
SELECT "user_id", SUM("delta") FROM "refunds" GROUP BY "user_id"
ON CONFLICT ("user_id") DO UPDATE SET "balance" = "wallet"."balance" + EXCLUDED."balance";--> statement-breakpoint
UPDATE "tanks" SET "equipment" = jsonb_set("equipment", '{co2,tier}', '0'::jsonb)
WHERE "id" IN (SELECT "id" FROM "blackwater_co2_removed");
