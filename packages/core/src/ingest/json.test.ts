import { describe, expect, it } from 'vitest';
import { PermanentIngestError } from './errors';
import { extract } from './extract';
import { jsonRecords, jsonSegments, type Json } from './json';

describe('jsonRecords', () => {
  it('makes one record per object in a list, keeping the parent’s other fields', () => {
    const doc: Json = {
      shop: 'Cairn Supplies',
      'opening hours': '9–5',
      orders: [
        { id: 7, customer: { name: 'Ada', city: 'London' }, tags: ['rush', 'gift'], paid: true },
        { id: 8, customer: { name: 'Bob' }, note: null, empty: '' },
      ],
    };
    expect(jsonRecords(doc)).toEqual([
      { path: '$', lines: ['shop: Cairn Supplies', '["opening hours"]: 9–5'] },
      {
        path: '$.orders[0]',
        lines: [
          'id: 7',
          'customer.name: Ada',
          'customer.city: London',
          'tags[0]: rush',
          'tags[1]: gift',
          'paid: true',
        ],
      },
      { path: '$.orders[1]', lines: ['id: 8', 'customer.name: Bob', 'note: null'] },
    ]);
  });

  it('splits nested lists of objects into records of their own', () => {
    const doc: Json = [
      { id: 1, items: [{ sku: 'a' }, { sku: 'b' }] },
      { id: 2, items: [{ sku: 'c' }] },
    ];
    expect(jsonRecords(doc).map((r) => [r.path, r.lines])).toEqual([
      ['$[0]', ['id: 1']],
      ['$[0].items[0]', ['sku: a']],
      ['$[0].items[1]', ['sku: b']],
      ['$[1]', ['id: 2', 'items[0].sku: c']],
    ]);
  });

  it('handles a bare value, and stops flattening very deep nesting', () => {
    expect(jsonRecords('hello')).toEqual([{ path: '$', lines: ['(value): hello'] }]);
    let deep: unknown = 'bottom';
    for (let i = 0; i < 40; i++) deep = { d: deep };
    const [record] = jsonRecords(deep as never);
    expect(record!.lines).toHaveLength(1);
    expect(record!.lines[0]).toMatch(/^d(\.d){32}: \{"d":/);
  });
});

describe('jsonSegments', () => {
  it('packs whole records with their path, located by path', () => {
    const doc = { orders: Array.from({ length: 20 }, (_, i) => ({ id: i, item: 'stone' })) };
    const segments = jsonSegments(JSON.stringify(doc), 120);
    expect(segments.length).toBeGreaterThan(3);
    expect(segments[0]!.text.split('\n')[0]).toBe('$.orders[0]: id: 0; item: stone');
    expect(segments[0]!.location.path).toMatch(/^\$\.orders\[0\] … \$\.orders\[\d+\]$/);
    expect(segments.at(-1)!.location.path).toMatch(/\$\.orders\[19\]$/);
    for (const s of segments) expect(s.text.length).toBeLessThanOrEqual(120);
  });

  it('reads JSON Lines, one record per line, located by line', () => {
    const text =
      '{"level":"info","msg":"start"}\n\n{"level":"error","msg":"disk full","ctx":{"disk":"/dev/sda"}}\n';
    expect(jsonSegments(text, 2400)).toEqual([
      {
        text: 'level: info; msg: start\nlevel: error; msg: disk full; ctx.disk: /dev/sda',
        location: { lines: [1, 3] },
      },
    ]);
  });

  it('rejects text that is neither JSON nor JSON Lines, naming the line', () => {
    expect(() => jsonSegments('{"a":1}\n{"b":\n', 2400)).toThrow(PermanentIngestError);
    expect(() => jsonSegments('{"a":1}\n{"b":\n', 2400)).toThrow(/line 2/);
  });
});

describe('extract (json)', () => {
  it('decodes and packs a document', async () => {
    const data = new TextEncoder().encode('{"name":"Cairn","tags":["a","b"]}');
    expect(await extract('json', data, { maxChars: 2400 })).toEqual([
      { text: '$: name: Cairn; tags[0]: a; tags[1]: b', location: { path: '$' } },
    ]);
  });
});
