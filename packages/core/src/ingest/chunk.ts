import type { ChunkLocation } from '../db';
import type { Segment } from './extract';

export interface TextChunk {
  content: string;
  location: ChunkLocation;
}

export interface ChunkOptions {
  /** Target chunk length; ~4 characters per token, so 2400 ≈ 600 tokens. */
  maxChars: number;
  /** Text repeated at the start of the next chunk, so a sentence cut at a boundary is whole in one of them. */
  overlapChars: number;
}

export const DEFAULT_CHUNKING: ChunkOptions = { maxChars: 2400, overlapChars: 360 };

// Coarsest first: paragraphs, lines, sentences, words. A separator stays with the text before it.
const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

type Range = [start: number, end: number];

/**
 * Splits each segment into chunks of at most `maxChars`, preferring paragraph, then line, sentence and
 * word boundaries. Chunks never span segments, so each keeps its segment's page or heading path.
 */
export function chunkSegments(
  segments: Segment[],
  opts: ChunkOptions = DEFAULT_CHUNKING,
): TextChunk[] {
  if (opts.overlapChars >= opts.maxChars)
    throw new Error('overlapChars must be smaller than maxChars');
  return segments.flatMap((segment) =>
    pack(segment.text, split(segment.text, 0, segment.text.length, 0, opts.maxChars), opts).flatMap(
      ([start, end]) => {
        const raw = segment.text.slice(start, end);
        const content = raw.trim();
        if (!content) return [];
        const location: ChunkLocation = { ...segment.location };
        if (segment.location.offset !== undefined) {
          location.offset = segment.location.offset + start + (raw.length - raw.trimStart().length);
        }
        return [{ content, location }];
      },
    ),
  );
}

/** Contiguous ranges covering [start, end), each at most `max` long. */
function split(text: string, start: number, end: number, level: number, max: number): Range[] {
  if (end - start <= max) return [[start, end]];
  const sep = SEPARATORS[level];
  if (sep === undefined) {
    // No separator left (a very long word or a run without spaces): cut hard.
    const ranges: Range[] = [];
    for (let i = start; i < end; i += max) ranges.push([i, Math.min(i + max, end)]);
    return ranges;
  }
  const ranges: Range[] = [];
  let from = start;
  for (
    let at = text.indexOf(sep, start);
    at !== -1 && at < end;
    at = text.indexOf(sep, at + sep.length)
  ) {
    ranges.push([from, at + sep.length]);
    from = at + sep.length;
  }
  if (from < end) ranges.push([from, end]);
  return ranges.flatMap(([s, e]) => split(text, s, e, level + 1, max));
}

/**
 * Greedily joins adjacent ranges into chunks of at most `maxChars`. Each new chunk starts inside the end of
 * the previous one (up to `overlapChars` back), at a sentence or word boundary.
 */
function pack(text: string, ranges: Range[], { maxChars, overlapChars }: ChunkOptions): Range[] {
  const chunks: Range[] = [];
  let start = ranges[0]?.[0] ?? 0;
  let i = 0; // first range that ends after `start`
  while (i < ranges.length) {
    let last = i;
    while (last + 1 < ranges.length && ranges[last + 1]![1] - start <= maxChars) last++;
    const end = ranges[last]![1];
    chunks.push([start, end]);
    if (last === ranges.length - 1) break;

    // The next chunk must reach the end of the next range, so the overlap can't push it over maxChars.
    const earliest = Math.max(end - overlapChars, ranges[last + 1]![1] - maxChars, start + 1);
    start = overlapStart(text, earliest, end);
    i = last + 1;
    while (i > 0 && ranges[i - 1]![1] > start) i--;
  }
  return chunks;
}

/**
 * Where the overlap starts: after the first sentence end in [from, to), else after the first space,
 * else `to` (no overlap rather than a cut word). A boundary right at `to` would give no overlap, so it
 * doesn't count.
 */
function overlapStart(text: string, from: number, to: number): number {
  const window = text.slice(from, to);
  for (const boundary of [/[.!?;]\s+|\n+/g, /\s+/g]) {
    for (const m of window.matchAll(boundary)) {
      const at = from + m.index + m[0].length;
      if (at < to) return at;
    }
  }
  return to;
}
