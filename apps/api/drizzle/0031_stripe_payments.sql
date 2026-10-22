CREATE TYPE "public"."payment_charge_kind" AS ENUM('pack', 'invoice');--> statement-breakpoint
CREATE TYPE "public"."payment_dispute_state" AS ENUM('lost', 'won');--> statement-breakpoint
CREATE TABLE "adult_confirmations" (
	"user_id" text PRIMARY KEY NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"status" text NOT NULL,
	"status_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"paid_invoice_id" text,
	"paid_start" timestamp with time zone,
	"paid_end" timestamp with time zone,
	"paid_revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "payment_charge_kind" NOT NULL,
	"user_id" text,
	"payment_intent_id" text,
	"amount_cents" integer NOT NULL,
	"pack_id" text,
	"pack_pearls" integer,
	"subscription_id" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_charges_amount_nonneg" CHECK ("payment_charges"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
	"dispute_id" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"state" "payment_dispute_state" NOT NULL,
	"cents" integer NOT NULL,
	"pearls" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_intent_links" (
	"payment_intent_id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"refund_id" text PRIMARY KEY NOT NULL,
	"charge_id" text NOT NULL,
	"cents" integer NOT NULL,
	"pearls" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "adult_confirmations" ADD CONSTRAINT "adult_confirmations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_subscriptions" ADD CONSTRAINT "club_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_charges" ADD CONSTRAINT "payment_charges_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_charge_id_payment_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."payment_charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_charge_id_payment_charges_id_fk" FOREIGN KEY ("charge_id") REFERENCES "public"."payment_charges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_subscriptions_user_idx" ON "club_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_charges_intent_idx" ON "payment_charges" USING btree ("payment_intent_id") WHERE "payment_charges"."payment_intent_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_charges_subscription_idx" ON "payment_charges" USING btree ("subscription_id");