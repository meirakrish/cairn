CREATE TABLE "source_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"row" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "source_rows_source_row_key" UNIQUE("source_id","row")
);
--> statement-breakpoint
ALTER TABLE "source_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "columns" jsonb;--> statement-breakpoint
ALTER TABLE "source_rows" ADD CONSTRAINT "source_rows_source_fk" FOREIGN KEY ("source_id","cairn_id") REFERENCES "public"."sources"("id","cairn_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_rows_cairn_id_idx" ON "source_rows" USING btree ("cairn_id");--> statement-breakpoint
CREATE POLICY "source_rows_read" ON "source_rows" AS PERMISSIVE FOR SELECT TO public USING (exists (select 1 from cairns c where c.id = "source_rows"."cairn_id"));--> statement-breakpoint
CREATE POLICY "source_rows_insert" ON "source_rows" AS PERMISSIVE FOR INSERT TO public WITH CHECK (exists (select 1 from cairn_access("source_rows"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "source_rows_update" ON "source_rows" AS PERMISSIVE FOR UPDATE TO public USING (exists (select 1 from cairn_access("source_rows"."cairn_id") a where a.role in ('owner', 'editor'))) WITH CHECK (exists (select 1 from cairn_access("source_rows"."cairn_id") a where a.role in ('owner', 'editor')));--> statement-breakpoint
CREATE POLICY "source_rows_delete" ON "source_rows" AS PERMISSIVE FOR DELETE TO public USING (exists (select 1 from cairn_access("source_rows"."cairn_id") a where a.role in ('owner', 'editor')));