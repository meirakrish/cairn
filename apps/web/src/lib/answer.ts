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

/** "page 3", "Setup › Linux", "rows 2–40", or "" — where a passage sits in its file. */
export function describeLocation(location: CitedPassage['location']): string {
  if (location.page) return `page ${location.page}`;
  if (location.rows) {
    const [first, last] = location.rows;
    return first === last ? `row ${first}` : `rows ${first}–${last}`;
  }
  if (location.headings?.length) return location.headings.join(' › ');
  return '';
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
