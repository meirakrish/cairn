CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"location" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED NOT NULL,
	CONSTRAINT "chunks_source_ordinal_key" UNIQUE("source_id","ordinal")
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"storage_key" text NOT NULL,
	"size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "sources_id_cairn_id_key" UNIQUE("id","cairn_id"),
	CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('text', 'markdown', 'pdf')),
	CONSTRAINT "sources_status_check" CHECK ("sources"."status" in ('pending', 'processing', 'ready', 'failed')),
	CONSTRAINT "sources_size_check" CHECK ("sources"."size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_fk" FOREIGN KEY ("source_id","cairn_id") REFERENCES "public"."sources"("id","cairn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_cairn_id_cairns_id_fk" FOREIGN KEY ("cairn_id") REFERENCES "public"."cairns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_cairn_id_idx" ON "chunks" USING btree ("cairn_id");--> statement-breakpoint
CREATE INDEX "chunks_embedding_idx" ON "chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "sources_cairn_id_idx" ON "sources" USING btree ("cairn_id","created_at");--> statement-breakpoint
CREATE POLICY "chunks_cairn" ON "chunks" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from cairns c where c.id = "chunks"."cairn_id")) WITH CHECK (exists (select 1 from cairns c where c.id = "chunks"."cairn_id"));--> statement-breakpoint
CREATE POLICY "sources_cairn" ON "sources" AS PERMISSIVE FOR ALL TO public USING (exists (select 1 from cairns c where c.id = "sources"."cairn_id")) WITH CHECK (exists (select 1 from cairns c where c.id = "sources"."cairn_id"));