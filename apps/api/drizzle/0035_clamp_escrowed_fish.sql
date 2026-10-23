UPDATE "gift_offers" SET "fish" = jsonb_set("gift_offers"."fish", '{size}', to_jsonb(CASE "tanks"."size"
  WHEN 'nano30' THEN 0.2168
  WHEN 'standard' THEN 0.3518
  WHEN 'std200' THEN 0.3643
  WHEN 'long300' THEN 0.3116
END))
FROM "tanks"
WHERE "gift_offers"."from_tank_id" = "tanks"."id"
  AND ("gift_offers"."fish"->>'size')::double precision > CASE "tanks"."size"
    WHEN 'nano30' THEN 0.2168
    WHEN 'standard' THEN 0.3518
    WHEN 'std200' THEN 0.3643
    WHEN 'long300' THEN 0.3116
  END;
