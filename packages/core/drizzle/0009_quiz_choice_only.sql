-- Written answers were removed: drop their questions (attempts cascade).
DELETE FROM "quiz_questions" WHERE "format" = 'open';--> statement-breakpoint
ALTER TABLE "quiz_attempts" DROP CONSTRAINT "quiz_attempts_verdict_check";--> statement-breakpoint
ALTER TABLE "quiz_attempts" DROP CONSTRAINT "quiz_attempts_answered_check";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP CONSTRAINT "quiz_questions_format_check";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP CONSTRAINT "quiz_questions_choices_check";--> statement-breakpoint
DROP INDEX "quiz_questions_cairn_idx";--> statement-breakpoint
ALTER TABLE "quiz_questions" ALTER COLUMN "choices" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_questions" ALTER COLUMN "correct_choice" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_questions" ALTER COLUMN "explanation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD COLUMN "choice" integer;--> statement-breakpoint
UPDATE "quiz_attempts" SET "choice" = "response"::integer WHERE "response" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "quiz_questions_cairn_idx" ON "quiz_questions" USING btree ("cairn_id");--> statement-breakpoint
ALTER TABLE "quiz_attempts" DROP COLUMN "response";--> statement-breakpoint
ALTER TABLE "quiz_attempts" DROP COLUMN "feedback";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "format";--> statement-breakpoint
ALTER TABLE "quiz_questions" DROP COLUMN "key_points";--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_verdict_check" CHECK ("quiz_attempts"."verdict" is null or "quiz_attempts"."verdict" in ('correct', 'wrong'));--> statement-breakpoint
ALTER TABLE "quiz_attempts" ADD CONSTRAINT "quiz_attempts_answered_check" CHECK (("quiz_attempts"."answered_at" is null) = ("quiz_attempts"."verdict" is null) and ("quiz_attempts"."verdict" is null) = ("quiz_attempts"."choice" is null));--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_choice_check" CHECK ("quiz_questions"."correct_choice" >= 0 and "quiz_questions"."correct_choice" < jsonb_array_length("quiz_questions"."choices"));