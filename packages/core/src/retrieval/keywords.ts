// Words too common to help a keyword match. The `simple` text-search config keeps them (it has no
// stopwords, so it works for any language), so a question is filtered here instead. English only for now.
const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below
  between both but by can could did do does doing down during each few for from further had has have
  having he her here hers herself him himself his how i if in into is it its itself just me more most my
  myself no nor not now of off on once only or other our ours ourselves out over own same she should so
  some such than that the their theirs them themselves then there these they this those through to too
  under until up very was we were what when where which while who whom why will with would you your
  yours yourself yourselves tell show give list explain describe please`.split(/\s+/),
);

const MAX_TERMS = 32;

// Hebrew vowel points and cantillation; most text (and the indexed chunks) is written without them.
// Only Hebrew's: other scripts, such as Devanagari, spell with combining marks.
const HEBREW_MARKS = /(?=\p{Script=Hebrew})\p{M}/gu;

/**
 * The words of a text that carry meaning: lowercased letters and digits, no stopwords or 1-letter words.
 * Hebrew vowel points are dropped, so a pointed word stays whole and matches its plain spelling.
 */
export function contentWords(text: string): Set<string> {
  const terms = new Set<string>();
  for (const [word] of text
    .replace(HEBREW_MARKS, '')
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}]+/gu)) {
    if (word.length > 1 && !STOPWORDS.has(word)) terms.add(word);
  }
  return terms;
}

// Hebrew writes some words as prefixes: ו and, ה the, ב in, כ as, ל to, מ from, ש that, often stacked
// (ובבית, "and in the house"). Up to three are dropped, keeping at least three letters of the word.
// The `chunk_tsv` SQL function (migration 0013) applies the same rule to chunks; keep them in sync.
const HEBREW_PREFIX = /^[והבכלמש]{1,3}/;
const HEBREW_WORD = /^[\u05D0-\u05EA]+$/;
const MIN_STEM = 3;

/** ובבית → בבית, בית: the word without each run of leading prefix letters that leaves a stem. */
export function hebrewVariants(word: string): string[] {
  if (!HEBREW_WORD.test(word)) return [];
  const prefix = HEBREW_PREFIX.exec(word)?.[0] ?? '';
  const variants: string[] = [];
  for (let k = 1; k <= prefix.length && word.length - k >= MIN_STEM; k++) {
    variants.push(word.slice(k));
  }
  return variants;
}

/**
 * Turns a question into an OR tsquery string ("deadline | filing"), or undefined when nothing is left.
 * Hebrew words bring their variants without prefixes. Terms are letters and digits only, so the result
 * is safe to pass to to_tsquery.
 */
export function keywordQuery(question: string): string | undefined {
  const words = [...contentWords(question)].slice(0, MAX_TERMS);
  const terms = new Set(words.flatMap((w) => [w, ...hebrewVariants(w)]));
  return terms.size ? [...terms].join(' | ') : undefined;
}
