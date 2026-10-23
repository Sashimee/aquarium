CREATE TABLE "owned_rooms" (
	"user_id" text NOT NULL,
	"room_id" text NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owned_rooms_user_id_room_id_pk" PRIMARY KEY("user_id","room_id")
);
--> statement-breakpoint
ALTER TABLE "ledger" DROP CONSTRAINT "ledger_delta_nonzero";--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "room_id" text DEFAULT 'room-living';--> statement-breakpoint
ALTER TABLE "tanks" ADD COLUMN "room_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owned_rooms" ADD CONSTRAINT "owned_rooms_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger" ADD CONSTRAINT "ledger_delta_nonzero" CHECK ("ledger"."delta" <> 0 or "ledger"."reason" = 'grant');