CREATE TABLE "community_feeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"food" text NOT NULL,
	"portion" double precision NOT NULL,
	"fed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_tank" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"tank_id" uuid NOT NULL,
	CONSTRAINT "community_tank_tank_id_unique" UNIQUE("tank_id"),
	CONSTRAINT "community_tank_singleton" CHECK ("community_tank"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "tanks" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "community_feeds" ADD CONSTRAINT "community_feeds_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_tank" ADD CONSTRAINT "community_tank_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_feeds_user_key_idx" ON "community_feeds" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "community_feeds_fed_at_idx" ON "community_feeds" USING btree ("fed_at");