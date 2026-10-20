CREATE TABLE "query_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"user_id" uuid,
	"question" text NOT NULL,
	"chunk_count" integer NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "query_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_log" ADD CONSTRAINT "query_log_cairn_id_cairns_id_fk" FOREIGN KEY ("cairn_id") REFERENCES "public"."cairns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_log" ADD CONSTRAINT "query_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "query_log_cairn_id_idx" ON "query_log" USING btree ("cairn_id","created_at");--> statement-breakpoint
CREATE POLICY "query_log_cairn" ON "query_log" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from cairns c where c.id = "query_log"."cairn_id")) WITH CHECK (exists (select 1 from cairns c where c.id = "query_log"."cairn_id"));