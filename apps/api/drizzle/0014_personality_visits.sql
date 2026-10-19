CREATE TABLE "tank_visits" (
	"tank_id" uuid NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "tank_visits_tank_id_day_pk" PRIMARY KEY("tank_id","day")
);
--> statement-breakpoint
ALTER TABLE "tank_visits" ADD CONSTRAINT "tank_visits_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "fish" SET "personality" = jsonb_build_object('boldness', round(((('x' || substr(md5("id"::text || 'boldness'), 1, 8))::bit(32)::bigint)::numeric / 4294967295), 3), 'greed', round(((('x' || substr(md5("id"::text || 'greed'), 1, 8))::bit(32)::bigint)::numeric / 4294967295), 3), 'sociability', round(((('x' || substr(md5("id"::text || 'sociability'), 1, 8))::bit(32)::bigint)::numeric / 4294967295), 3)) WHERE "personality" = '{"boldness":0.5,"greed":0.5,"sociability":0.5}'::jsonb;