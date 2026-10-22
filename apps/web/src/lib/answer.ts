import type { CitedPassage } from '@cairn/shared';

export type Segment = { text: string } | { cite: number };

/**
 * Splits an answer into text and citations, so [2] and [1, 3] can render as buttons. Only numbers of
 * passages that exist become citations; anything else stays text.
 */
export function splitCitations(answer: string, passageCount: number): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const m of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    const numbers = m[1]!.split(',').map(Number);
    if (!numbers.every((n) => n >= 1 && n <= passageCount)) continue;
    if (m.index > last) segments.push({ text: answer.slice(last, m.index) });
    for (const n of numbers) segments.push({ cite: n });
    last = m.index + m[0].length;
  }
  if (last < answer.length) segments.push({ text: answer.slice(last) });
  return segments;
}

/** "page 3", "Setup › Linux", "rows 2–40", "lines 5–9", "$.orders[3]", or "" — where a passage sits in its file. */
const span = (unit: string, [first, last]: [number, number]) =>
  first === last ? `${unit} ${first}` : `${unit}s ${first}–${last}`;

export function describeLocation(location: CitedPassage['location']): string {
  if (location.page) return `page ${location.page}`;
  if (location.rows) return span('row', location.rows);
  if (location.lines) return span('line', location.lines);
  if (location.path) return location.path;
  if (location.headings?.length) return location.headings.join(' › ');
  return '';
}

/** What a table query did, for a source line: "rows where Region = "West"; sum(Amount) · 3 rows matched". */
export function describeQuery(query: NonNullable<CitedPassage['query']>): string {
  return `${query.description} · ${query.matched} ${query.matched === 1 ? 'row' : 'rows'} matched`;
}

/**
 * A link to the cited part of a web page: the page with a text fragment (`#:~:text=`) made of the
 * passage's first words. Headings, table rows and code are skipped, since the page shows them
 * differently; where a browser can't match the fragment, it opens the page at the top. Anything but
 * http(s) gets no link.
 */
export function pageLink(url: string, passage: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined;
  const page = url.split('#')[0]!;
  let fenced = false;
  for (const raw of passage.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) fenced = !fenced;
    if (fenced || !line || line.startsWith('```') || line.startsWith('#') || line.includes(' | ')) {
      continue;
    }
    const words = line
      .replace(/^([-*>]|\d+\.)\s+/, '')
      .replace(/[*_`]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .join(' ');
    // In a fragment, - & and , have meanings of their own.
    if (words) return `${page}#:~:text=${encodeURIComponent(words).replace(/-/g, '%2D')}`;
  }
  return page;
}

/** "example.com" from a URL, for showing where a page came from. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Reads Server-Sent Events from a fetch body (EventSource can't POST) and yields each `data:` payload.
 * Comment lines (`: ping`) are skipped.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // stream: true keeps a multi-byte character split across chunks intact.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) yield data;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
