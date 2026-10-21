import { describe, expect, it } from 'vitest';
import { csvSegments, parseCsv, sniffDelimiter } from './csv';
import { PermanentIngestError } from './errors';
import { extract } from './extract';
import { packRecords } from './records';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, delimiters and newlines inside quotes', () => {
    const text = 'name,note\n"Ada, Countess","said ""hi""\nthen left"\nBob,\n';
    expect(parseCsv(text, ',')).toEqual([
      ['name', 'note'],
      ['Ada, Countess', 'said "hi"\nthen left'],
      ['Bob', ''],
    ]);
  });

  it('keeps empty lines as one empty field, and a last row without a newline', () => {
    expect(parseCsv('a\n\nb', ',')).toEqual([['a'], [''], ['b']]);
  });

  it('rejects a quoted field that never closes', () => {
    expect(() => parseCsv('a,"b\nc', ',')).toThrow(PermanentIngestError);
  });
});

describe('sniffDelimiter', () => {
  it('picks the delimiter that splits rows consistently', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3\n4,5,6\n')).toBe(',');
    expect(sniffDelimiter('a;b;c\n1,5;2;3\n4;5,5;6\n')).toBe(';');
    expect(sniffDelimiter('a\tb\n"x, y"\t2\n')).toBe('\t');
    expect(sniffDelimiter('a|b\n1|2\n')).toBe('|');
  });

  it('falls back to comma for a single column', () => {
    expect(sniffDelimiter('name\nAda\nBob\n')).toBe(',');
  });
});

describe('csvSegments', () => {
  const csv = [
    'name,city,,city',
    'Ada,London,x,Paris',
    ',,,',
    '"Bob ""B""",, ,Rome',
    'Cy,Oslo,,',
  ].join('\n');

  it('turns rows into `column: value` lines with spreadsheet row numbers', () => {
    expect(csvSegments(csv, 2400)).toEqual([
      {
        text: [
          'name: Ada; city: London; column 3: x; city (2): Paris',
          'name: Bob "B"; city (2): Rome',
          'name: Cy; city: Oslo',
        ].join('\n'),
        location: { rows: [2, 5] },
      },
    ]);
  });

  it('groups whole rows up to maxChars', () => {
    const rows = Array.from({ length: 30 }, (_, i) => `id${i},${'v'.repeat(20)}`);
    const segments = csvSegments(['id,value', ...rows].join('\n'), 100);
    expect(segments.length).toBeGreaterThan(5);
    for (const s of segments) expect(s.text.length).toBeLessThanOrEqual(100);
    expect(segments[0]!.location.rows![0]).toBe(2);
    expect(segments.at(-1)!.location.rows![1]).toBe(31);
    // Contiguous, and no row split: every line is a whole row.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.location.rows![0]).toBe(segments[i - 1]!.location.rows![1] + 1);
    }
    expect(segments.flatMap((s) => s.text.split('\n'))).toHaveLength(30);
  });

  it('gives nothing for a header-only or empty file', () => {
    expect(csvSegments('a,b\n', 2400)).toEqual([]);
    expect(csvSegments('', 2400)).toEqual([]);
  });
});

describe('packRecords', () => {
  it('puts a record longer than maxChars in a segment of its own', () => {
    const records = [
      { text: 'short', row: 2 },
      { text: 'x'.repeat(50), row: 3 },
      { text: 'tail', row: 4 },
    ];
    expect(packRecords(records, 20).map((s) => s.location.rows)).toEqual([
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });
});

describe('extract (csv)', () => {
  it('decodes, normalises line endings and packs with the given chunk size', async () => {
    const data = new TextEncoder().encode('﻿a;b\r\n1;2\r\n3;4\r\n');
    expect(await extract('csv', data, 2400)).toEqual([
      { text: 'a: 1; b: 2\na: 3; b: 4', location: { rows: [2, 3] } },
    ]);
  });
});
