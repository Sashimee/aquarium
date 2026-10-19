CREATE TYPE "public"."reaction_kind" AS ENUM('heart', 'star', 'wow');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"tank_id" uuid,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tank_reactions" (
	"tank_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "reaction_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tank_reactions_tank_id_user_id_pk" PRIMARY KEY("tank_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tanks" RENAME COLUMN "share_token" TO "share_token_hash";--> statement-breakpoint
UPDATE "tanks" SET "share_token_hash" = encode(sha256(convert_to("share_token_hash", 'UTF8')), 'hex') WHERE "share_token_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tanks" DROP CONSTRAINT "tanks_share_token_unique";--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_reactions" ADD CONSTRAINT "tank_reactions_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_reactions" ADD CONSTRAINT "tank_reactions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tank_id_at_idx" ON "audit_log" USING btree ("tank_id","at");--> statement-breakpoint
CREATE INDEX "tank_reactions_user_id_idx" ON "tank_reactions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tanks" ADD CONSTRAINT "tanks_share_token_hash_unique" UNIQUE("share_token_hash");