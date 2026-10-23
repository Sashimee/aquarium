UPDATE "fish" SET "size" = CASE "tanks"."size"
  WHEN 'nano30' THEN 0.2168
  WHEN 'standard' THEN 0.3518
  WHEN 'std200' THEN 0.3643
  WHEN 'long300' THEN 0.3116
END
FROM "tanks"
WHERE "fish"."tank_id" = "tanks"."id"
  AND "fish"."size" > CASE "tanks"."size"
    WHEN 'nano30' THEN 0.2168
    WHEN 'standard' THEN 0.3518
    WHEN 'std200' THEN 0.3643
    WHEN 'long300' THEN 0.3116
  END;
