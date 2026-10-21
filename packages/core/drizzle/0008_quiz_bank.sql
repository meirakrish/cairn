DROP POLICY "quiz_questions_own" ON "quiz_questions" CASCADE;--> statement-breakpoint
CREATE TABLE "quiz_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_id" uuid NOT NULL,
	"cairn_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"response" text,
	"verdict" text,
	"feedback" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_attempts_verdict_check" CHECK ("quiz_attempts"."verdict" is null or "quiz_attempts"."verdict" in ('correct', 'partial', 'wrong')),
	CONSTRAINT "quiz_attempts_answered_check" CHECK (("quiz_attempts"."answered_at" is null) = ("quiz_attempts"."verdict" is null) and ("quiz_attempts"."verdict" is null) = ("quiz_attempts"."response" is null))
);
--> statement-breakpoint
ALTER TABLE "quiz_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP CONSTRAINT "quiz_questions_verdict_check";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP CONSTRAINT "quiz_questions_answered_check";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP CONSTRAINT "quiz_questions_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "quiz_questions_user_cairn_idx";--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_question_id_quiz_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."quiz_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_cairn_id_cairns_id_fk" FOREIGN KEY ("cairn_id") REFERENCES "public"."cairns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_attempts_user_cairn_idx" ON "quiz_attempts" USING btree ("user_id","cairn_id","created_at");--> statement-breakpoint
CREATE INDEX "quiz_attempts_question_id_idx" ON "quiz_attempts" USING btree ("question_id");--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_questions_cairn_idx" ON "quiz_questions" USING btree ("cairn_id","format");--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "response";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "verdict";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "feedback";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "answered_at";--> statement-breakpoint
CREATE POLICY "quiz_questions_read" ON "quiz_questions" AS PERMISSIVE FOR SELECT TO public USING (exists (select 1 from cairn_access("quiz_questions"."cairn_id") a where a.visibility = 'cited'));--> statement-breakpoint
CREATE POLICY "quiz_questions_insert" ON "quiz_questions" AS PERMISSIVE FOR INSERT TO public WITH CHECK ("quiz_questions"."created_by" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairn_access("quiz_questions"."cairn_id") a where a.visibility = 'cited'));--> statement-breakpoint
CREATE POLICY "quiz_attempts_own" ON "quiz_attempts" AS PERMISSIVE FOR ALL TO public USING ("quiz_attempts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairn_access("quiz_attempts"."cairn_id") a where a.visibility = 'cited')) WITH CHECK ("quiz_attempts"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairn_access("quiz_attempts"."cairn_id") a where a.visibility = 'cited'));