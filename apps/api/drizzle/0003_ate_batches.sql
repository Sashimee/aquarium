CREATE TABLE "ate_batches" (
	"tank_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ate_batches_tank_id_batch_id_pk" PRIMARY KEY("tank_id","batch_id")
);
--> statement-breakpoint
ALTER TABLE "ate_batches" ADD CONSTRAINT "ate_batches_tank_id_tanks_id_fk" FOREIGN KEY ("tank_id") REFERENCES "public"."tanks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ate_batches_created_at_idx" ON "ate_batches" USING btree ("created_at");