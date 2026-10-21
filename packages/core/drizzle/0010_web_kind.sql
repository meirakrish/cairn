ALTER TABLE "sources" DROP CONSTRAINT "sources_kind_check";--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_kind_check" CHECK ("sources"."kind" in ('text', 'markdown', 'pdf', 'csv', 'json', 'image', 'web'));