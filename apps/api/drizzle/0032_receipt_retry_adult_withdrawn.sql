ALTER TABLE "adult_confirmations" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_charges" ADD COLUMN "receipt_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_charges" ADD COLUMN "receipt_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_charges" ADD COLUMN "receipt_next_try_at" timestamp with time zone;