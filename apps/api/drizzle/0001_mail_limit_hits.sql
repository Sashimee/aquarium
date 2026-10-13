CREATE TABLE "mail_limit_hits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mail_limit_hits_key_at_idx" ON "mail_limit_hits" USING btree ("key","at");