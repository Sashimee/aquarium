CREATE TYPE "public"."gift_status" AS ENUM('open', 'countered', 'accepted', 'declined', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "gift_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text,
	"from_tank_id" uuid NOT NULL,
	"status" "gift_status" DEFAULT 'open' NOT NULL,
	"fish" jsonb NOT NULL,
	"wants_return" boolean DEFAULT false NOT NULL,
	"recipient_tank_id" uuid,
	"pledged_fish_id" uuid,
	"creation_key" text NOT NULL,
	"accept_key" text,
	"confirm_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "accepts_gifts" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gift_offers" ADD CONSTRAINT "gift_offers_from_user_id_user_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_offers" ADD CONSTRAINT "gift_offers_to_user_id_user_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_offers" ADD CONSTRAINT "gift_offers_from_tank_id_tanks_id_fk" FOREIGN KEY ("from_tank_id") REFERENCES "public"."tanks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gift_offers_creation_key_idx" ON "gift_offers" USING btree ("from_user_id","creation_key");--> statement-breakpoint
CREATE INDEX "gift_offers_from_user_idx" ON "gift_offers" USING btree ("from_user_id","status");--> statement-breakpoint
CREATE INDEX "gift_offers_to_user_idx" ON "gift_offers" USING btree ("to_user_id","status");--> statement-breakpoint
CREATE INDEX "gift_offers_from_tank_idx" ON "gift_offers" USING btree ("from_tank_id");