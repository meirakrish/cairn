CREATE TABLE "quiz_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cairn_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"format" text NOT NULL,
	"question" text NOT NULL,
	"choices" jsonb,
	"correct_choice" integer,
	"answer" text NOT NULL,
	"key_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explanation" text,
	"response" text,
	"verdict" text,
	"feedback" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quiz_questions_format_check" CHECK ("quiz_questions"."format" in ('choice', 'open')),
	CONSTRAINT "quiz_questions_verdict_check" CHECK ("quiz_questions"."verdict" is null or "quiz_questions"."verdict" in ('correct', 'partial', 'wrong')),
	CONSTRAINT "quiz_questions_choices_check" CHECK (("quiz_questions"."format" = 'choice') = ("quiz_questions"."choices" is not null and "quiz_questions"."correct_choice" is not null)),
	CONSTRAINT "quiz_questions_answered_check" CHECK (("quiz_questions"."answered_at" is null) = ("quiz_questions"."verdict" is null) and ("quiz_questions"."verdict" is null) = ("quiz_questions"."response" is null))
);
--> statement-breakpoint
ALTER TABLE "quiz_questions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_cairn_id_cairns_id_fk" FOREIGN KEY ("cairn_id") REFERENCES "public"."cairns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiz_questions" ADD CONSTRAINT "quiz_questions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quiz_questions_user_cairn_idx" ON "quiz_questions" USING btree ("user_id","cairn_id","created_at");--> statement-breakpoint
CREATE INDEX "quiz_questions_chunk_id_idx" ON "quiz_questions" USING btree ("chunk_id");--> statement-breakpoint
CREATE POLICY "quiz_questions_own" ON "quiz_questions" AS PERMISSIVE FOR ALL TO public USING ("quiz_questions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairn_access("quiz_questions"."cairn_id") a where a.visibility = 'cited')) WITH CHECK ("quiz_questions"."user_id" = nullif(current_setting('app.user_id', true), '')::uuid and exists (select 1 from cairn_access("quiz_questions"."cairn_id") a where a.visibility = 'cited'));