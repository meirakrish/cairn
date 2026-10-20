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

/**
 * Turns a question into an OR tsquery string ("deadline | filing"), or undefined when nothing is left.
 * Terms are letters and digits only, so the result is safe to pass to to_tsquery.
 */
export function keywordQuery(question: string): string | undefined {
  const terms = new Set<string>();
  for (const [word] of question.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    if (word.length > 1 && !STOPWORDS.has(word)) terms.add(word);
    if (terms.size === MAX_TERMS) break;
  }
  return terms.size ? [...terms].join(' | ') : undefined;
}
