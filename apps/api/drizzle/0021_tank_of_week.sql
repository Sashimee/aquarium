CREATE TABLE "tank_of_week" (
	"week_start" timestamp with time zone PRIMARY KEY NOT NULL,
	"tank_id" uuid,
	"votes" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tank_votes" (
	"user_id" text NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"tank_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tank_votes_user_id_week_start_pk" PRIMARY KEY("user_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "in_gallery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tank_of_week" ADD CONSTRAINT "tank_of_week_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_votes" ADD CONSTRAINT "tank_votes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tank_votes" ADD CONSTRAINT "tank_votes_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tank_votes_week_tank_idx" ON "tank_votes" USING btree ("week_start","tank_id");--> statement-breakpoint
CREATE INDEX "tank_votes_tank_id_idx" ON "tank_votes" USING btree ("tank_id");