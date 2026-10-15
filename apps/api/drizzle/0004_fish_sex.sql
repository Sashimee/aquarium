CREATE TYPE "public"."fish_sex" AS ENUM('male', 'female');--> statement-breakpoint
ALTER TABLE "fish" ADD COLUMN "sex" "fish_sex";--> statement-breakpoint
CREATE FUNCTION pg_temp.fnv1a32(input text) RETURNS bigint AS $$
DECLARE
	h bigint := 2166136261;
	i integer;
BEGIN
	FOR i IN 1..length(input) LOOP
		h := (h # ascii(substr(input, i, 1))::bigint);
		h := (h * 16777619) % 4294967296;
	END LOOP;
	RETURN h;
END;
$$ LANGUAGE plpgsql IMMUTABLE;--> statement-breakpoint
UPDATE "fish" SET "sex" = CASE WHEN pg_temp.fnv1a32("id"::text || ':variant') < 2147483648 THEN 'male'::"fish_sex" ELSE 'female'::"fish_sex" END;--> statement-breakpoint
DROP FUNCTION pg_temp.fnv1a32(text);--> statement-breakpoint
ALTER TABLE "fish" ALTER COLUMN "sex" SET NOT NULL;
