import { describe, expect, it } from 'vitest';
import { chunkSegments } from './chunk';

const opts = { maxChars: 100, overlapChars: 30 };

describe('chunkSegments', () => {
  it('keeps short text in one chunk, trimmed, with its offset', () => {
    expect(
      chunkSegments([{ text: '\n\n  Hello world.  \n', location: { offset: 10 } }], opts),
    ).toEqual([{ content: 'Hello world.', location: { offset: 14 } }]);
  });

  it('never exceeds maxChars, cuts at paragraph ends, and overlaps at a sentence', () => {
    const para = (n: number) => `Paragraph ${n} starts. ` + 'word '.repeat(8).trim() + '.';
    const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
    const chunks = chunkSegments([{ text, location: { offset: 0 } }], opts);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(opts.maxChars);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const next = chunks[i]!;
      // Chunks end at a paragraph or sentence, never mid-word.
      expect(prev.content).toMatch(/[.]$/);
      // The next chunk starts within the previous one (overlap), at a word start.
      expect(next.location.offset!).toBeLessThan(prev.location.offset! + prev.content.length);
      expect(next.location.offset!).toBeGreaterThan(prev.location.offset!);
      expect(next.content).toMatch(/^(word|Paragraph)/);
    }
    // Together they cover every paragraph.
    for (const n of [1, 2, 3, 4, 5])
      expect(chunks.some((c) => c.content.includes(para(n)))).toBe(true);
  });

  it('makes progress when ranges are as long as a chunk', () => {
    const text = ['a'.repeat(95), 'b'.repeat(95), 'c'.repeat(95)].join(' ');
    const chunks = chunkSegments([{ text, location: {} }], opts);
    expect(chunks.map((c) => c.content[0])).toEqual(['a', 'b', 'c']);
  });

  it('records each chunk offset into the original text', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i}.`).join(' ');
    const chunks = chunkSegments([{ text, location: { offset: 0 } }], opts);

    for (const c of chunks) {
      expect(text.slice(c.location.offset!, c.location.offset! + c.content.length)).toBe(c.content);
    }
  });

  it('falls back to sentences, words, then a hard cut', () => {
    const sentences = chunkSegments([{ text: 'One two three. '.repeat(20), location: {} }], opts);
    for (const c of sentences) expect(c.content).toMatch(/^One two three\./);

    const blob = chunkSegments([{ text: 'x'.repeat(250), location: {} }], opts);
    expect(blob.map((c) => c.content.length)).toEqual([100, 100, 50]);
  });

  it('does not span segments and keeps each location', () => {
    const chunks = chunkSegments(
      [
        { text: 'First page text.', location: { page: 1 } },
        { text: '   ', location: { page: 2 } },
        { text: 'Third page text.', location: { page: 3 } },
      ],
      opts,
    );
    expect(chunks).toEqual([
      { content: 'First page text.', location: { page: 1 } },
      { content: 'Third page text.', location: { page: 3 } },
    ]);
  });

  it('rejects an overlap as large as the chunk', () => {
    expect(() => chunkSegments([], { maxChars: 10, overlapChars: 10 })).toThrow(/overlapChars/);
  });
});
