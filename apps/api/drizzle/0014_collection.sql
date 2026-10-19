CREATE TABLE "achievement_awards" (
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "achievement_awards_user_id_achievement_id_pk" PRIMARY KEY("user_id","achievement_id")
);
--> statement-breakpoint
CREATE TABLE "collection_entries" (
	"user_id" text NOT NULL,
	"species" text NOT NULL,
	"kept_at" timestamp with time zone NOT NULL,
	"bred_at" timestamp with time zone,
	"raised_at" timestamp with time zone,
	CONSTRAINT "collection_entries_user_id_species_pk" PRIMARY KEY("user_id","species")
);
--> statement-breakpoint
ALTER TABLE "achievement_awards" ADD CONSTRAINT "achievement_awards_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_entries" ADD CONSTRAINT "collection_entries_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "collection_entries" ("user_id", "species", "kept_at")
SELECT "owner_id", "species", min("born_at") FROM (
	SELECT t."owner_id", f."species", f."born_at" FROM "fish" f JOIN "tanks" t ON t."id" = f."tank_id"
	UNION ALL
	SELECT t."owner_id", m."species", m."born_at" FROM "memorials" m JOIN "tanks" t ON t."id" = m."tank_id"
) kept GROUP BY "owner_id", "species"
ON CONFLICT DO NOTHING;
