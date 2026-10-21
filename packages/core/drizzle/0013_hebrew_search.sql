-- Hebrew in keyword search. Vowel points and cantillation are dropped, so a pointed word stays one
-- lexeme. Hebrew words also get variants without their prefix letters (ו ה ב כ ל מ ש, up to three,
-- keeping at least three letters: ובבית → בבית, בית), weighted D below the text's own words (A).
-- hebrewVariants in src/retrieval/keywords.ts applies the same rule to questions; keep them in sync.
-- Calls are schema-qualified: pg_restore recomputes the column with an empty search_path.
CREATE FUNCTION hebrew_unpointed(content text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT regexp_replace(content, '[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]', '', 'g')
$$;--> statement-breakpoint
CREATE FUNCTION hebrew_variants(content text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT coalesce(string_agg(substr(m.word[1], k + 1), ' '), '')
  FROM regexp_matches(content, '[\u05D0-\u05EA]+', 'g') AS m(word),
    generate_series(1, 3) AS k
  WHERE char_length(m.word[1]) - k >= 3 AND substr(m.word[1], 1, k) ~ '^[והבכלמש]+$'
$$;--> statement-breakpoint
CREATE FUNCTION chunk_tsv(content text) RETURNS tsvector
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT setweight(to_tsvector('simple'::regconfig, public.hebrew_unpointed(content)), 'A')
    || setweight(to_tsvector('simple'::regconfig, public.hebrew_variants(public.hebrew_unpointed(content))), 'D')
$$;--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (chunk_tsv(content)) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "chunks_tsv_idx" ON "chunks" USING gin ("tsv");
