import { describe, expect, it } from 'vitest';
import { describeLocation, hostOf, pageLink, splitCitations, sseData } from './answer';

describe('splitCitations', () => {
  it('turns [n] and [n, m] into citations and keeps the text around them', () => {
    expect(splitCitations('Stones mark trails [1]. Both [2, 1].', 2)).toEqual([
      { text: 'Stones mark trails ' },
      { cite: 1 },
      { text: '. Both ' },
      { cite: 2 },
      { cite: 1 },
      { text: '.' },
    ]);
  });

  it('leaves numbers that are not passages as text', () => {
    expect(splitCitations('See [3] and [0] and [1].', 2)).toEqual([
      { text: 'See [3] and [0] and ' },
      { cite: 1 },
      { text: '.' },
    ]);
    expect(splitCitations('', 2)).toEqual([]);
  });
});

describe('describeLocation', () => {
  it('prefers the page, then the heading path', () => {
    expect(describeLocation({ page: 2 })).toBe('page 2');
    expect(describeLocation({ headings: ['A', 'B'] })).toBe('A › B');
    expect(describeLocation({ offset: 5 })).toBe('');
  });

  it('names row, line and path locations', () => {
    expect(describeLocation({ rows: [2, 40] })).toBe('rows 2–40');
    expect(describeLocation({ rows: [7, 7] })).toBe('row 7');
    expect(describeLocation({ lines: [3, 3] })).toBe('line 3');
    expect(describeLocation({ path: '$.orders[3] … $.orders[9]' })).toBe(
      '$.orders[3] … $.orders[9]',
    );
  });
});

describe('sseData', () => {
  it('yields data payloads across chunk boundaries and skips comments', async () => {
    const chunks = ['data: {"a":', '1}\n\n: ping\n\ndata: two\n', '\ndata: x\ndata: y\n\n'];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(body)) out.push(data);
    expect(out).toEqual(['{"a":1}', 'two', 'x\ny']);
  });

  it('keeps multi-byte characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('data: שלום\n\n');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 7)); // splits the first Hebrew letter
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(body)) out.push(data);
    expect(out).toEqual(['שלום']);
  });
});

describe('pageLink', () => {
  it('links to the first words of the passage text, past headings, tables and code', () => {
    const passage =
      '## Hours\n\n```\n# not this\n```\nTime | Day\n- The hut opens at 9, rain-or-shine & free.';
    expect(pageLink('https://example.com/hut', passage)).toBe(
      'https://example.com/hut#:~:text=The%20hut%20opens%20at%209%2C%20rain%2Dor%2Dshine%20%26%20free.',
    );
  });

  it('keeps only the first 8 words, drops an old fragment, and falls back to the page', () => {
    expect(pageLink('https://a.com/x#top', 'one two three four five six seven eight nine')).toBe(
      'https://a.com/x#:~:text=one%20two%20three%20four%20five%20six%20seven%20eight',
    );
    expect(pageLink('https://a.com/x', '## Only a heading')).toBe('https://a.com/x');
  });

  it('gives no link for other schemes', () => {
    expect(pageLink('javascript:alert(1)', 'text')).toBeUndefined();
    expect(pageLink('data:text/html,hi', 'text')).toBeUndefined();
  });
});

describe('hostOf', () => {
  it('gives the host, or the input when it is not a URL', () => {
    expect(hostOf('https://en.wikipedia.org/wiki/Cairn')).toBe('en.wikipedia.org');
    expect(hostOf('nonsense')).toBe('nonsense');
  });
});
