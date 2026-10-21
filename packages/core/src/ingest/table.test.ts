import { describe, expect, it } from 'vitest';
import { csvTable, jsonTable, readTable, TABLE_LIMITS } from './table';

const types = (t: ReturnType<typeof csvTable>) => t?.columns.map((c) => `${c.name}:${c.type}`);

describe('csvTable', () => {
  it('types each column from all its values and keeps spreadsheet row numbers', () => {
    const t = csvTable(
      [
        'Region,Amount,Day,Zip,Note',
        'West,5,2024-01-05,02134,ok',
        'East,12.5,2024-02-29,90210,',
        'West,,2024-03-01,10001,late',
      ].join('\n'),
    );

    expect(types(t)).toEqual([
      'Region:text',
      'Amount:number',
      'Day:date',
      'Zip:text', // leading zero: not a number
      'Note:text',
    ]);
    expect(t?.rows).toEqual([
      { row: 2, data: { Region: 'West', Amount: 5, Day: '2024-01-05', Zip: '02134', Note: 'ok' } },
      { row: 3, data: { Region: 'East', Amount: 12.5, Day: '2024-02-29', Zip: '90210' } },
      { row: 4, data: { Region: 'West', Day: '2024-03-01', Zip: '10001', Note: 'late' } },
    ]);
  });

  it('keeps one bad value from making a column a number or date column', () => {
    const t = csvTable('a,b,c\n1,2024-01-01,x\n2,2024-02-30,y\nn/a,2024-01-03,z');
    expect(types(t)).toEqual(['a:text', 'b:text', 'c:text']);
    expect(t?.rows[0]?.data).toEqual({ a: '1', b: '2024-01-01', c: 'x' });
  });

  it('leaves numbers that are unsafe or not plain as text', () => {
    const t = csvTable('big,sep,exp\n9007199254740993,"1,234",1e3\n1,2,3');
    expect(types(t)).toEqual(['big:text', 'sep:text', 'exp:text']);
  });

  it('skips empty rows, names extra and blank columns, and uses the sniffed delimiter', () => {
    const t = csvTable('a,,b\n1,2,3,4\n,,\n5,6,7');
    expect(types(t)).toEqual(['a:number', 'column 2:number', 'b:number', 'column 4:number']);
    expect(t?.rows.map((r) => r.row)).toEqual([2, 4]);
    expect(types(csvTable('x;y\n1;a\n2;b'))).toEqual(['x:number', 'y:text']);
  });

  it('gives nothing for a header-only or empty file, or one over the limits', () => {
    expect(csvTable('a,b')).toBeUndefined();
    expect(csvTable('')).toBeUndefined();
    const wide = Array.from({ length: TABLE_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`);
    expect(csvTable(`${wide.join(',')}\n${wide.map(() => 1).join(',')}`)).toBeUndefined();
  });
});

describe('jsonTable', () => {
  it('reads an array of flat objects: union of keys, index as row, null as absent', () => {
    const t = jsonTable(
      JSON.stringify([
        { name: 'Ada', age: 36, active: true },
        { name: 'Bo', age: null, city: 'Oslo' },
        { name: 'Cy', age: 4.5, city: '' },
      ]),
    );

    expect(types(t)).toEqual(['name:text', 'age:number', 'active:text', 'city:text']);
    expect(t?.rows).toEqual([
      { row: 0, data: { name: 'Ada', age: 36, active: 'true' } },
      { row: 1, data: { name: 'Bo', city: 'Oslo' } },
      { row: 2, data: { name: 'Cy', age: 4.5 } },
    ]);
  });

  it('reads JSON Lines, numbering rows by line', () => {
    const t = jsonTable('{"a":1}\n\n{"a":2,"b":"x"}\n');
    expect(types(t)).toEqual(['a:number', 'b:text']);
    expect(t?.rows.map((r) => r.row)).toEqual([1, 3]);
  });

  it('leaves nested values, wrappers, single records and broken files to their chunks', () => {
    expect(jsonTable('[{"a":{"b":1}},{"a":{"b":2}}]')).toBeUndefined();
    expect(jsonTable('[{"a":[1]},{"a":[2]}]')).toBeUndefined();
    expect(jsonTable('{"orders":[{"a":1},{"a":2}]}')).toBeUndefined();
    expect(jsonTable('[{"a":1}]')).toBeUndefined();
    expect(jsonTable('[1,2,3]')).toBeUndefined();
    expect(jsonTable('{"a":1}\nnot json')).toBeUndefined();
  });
});

describe('readTable', () => {
  it('reads CSV and JSON, and nothing else', () => {
    const bytes = new TextEncoder().encode('a,b\n1,2');
    expect(readTable('csv', bytes)?.rows).toHaveLength(1);
    expect(readTable('text', bytes)).toBeUndefined();
  });
});
