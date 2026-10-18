CREATE TABLE "cairns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"embed_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cairns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
ALTER TABLE "cairns" ADD CONSTRAINT "cairns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cairns_owner_id_idx" ON "cairns" USING btree ("owner_id");--> statement-breakpoint
CREATE POLICY "cairns_owner" ON "cairns" AS PERMISSIVE FOR ALL TO public USING ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid) WITH CHECK ("cairns"."owner_id" = nullif(current_setting('app.user_id', true), '')::uuid);