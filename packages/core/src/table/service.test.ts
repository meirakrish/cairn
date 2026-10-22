import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { NotFoundError } from '../errors';
import { csvTable, type ParsedTable } from '../ingest';
import { SourceService } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import { PlanError, TablePlan, TableService, type TablePlanInput } from '.';

const { admin, app } = createTestDbs();
const cairns = new CairnService(app.db, 'test-embed');
const sources = new SourceService(app.db);
const tables = new TableService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

const SALES = [
  'Region,Product,Amount,Day,Note',
  'West,Tent,100,2024-01-05,first',
  'West,Rope,40.5,2024-01-20,',
  'East,Tent,250,2024-02-11,big order',
  'East,Boots,80,2024-02-29,',
  'North,Tent,,2024-03-01,pending',
  'west,Boots,60,2024-03-15 10:30,50% off_sale',
].join('\n');

/** A cairn with one source: the sales table, another table, or (null) a source that is no table. */
async function setup(table: ParsedTable | null = csvTable(SALES)!) {
  const user = await createUser(admin.db);
  const cairn = await cairns.create(user.id, { name: 'Sales' });
  const source = await sources.create(user.id, cairn.id, {
    kind: 'csv',
    filename: 'sales.csv',
    mime: 'text/csv',
    size: 1,
  });
  await sources.complete(user.id, source.id, [], table ?? undefined);
  const run = (plan: TablePlanInput) => tables.run(user.id, source.id, TablePlan.parse(plan));
  return { user, cairn, source, run };
}

describe('TableService.run: aggregating', () => {
  it('counts all rows, or the non-empty values of a column', async () => {
    const { run } = await setup();

    expect(await run({ aggregates: [{ fn: 'count' }] })).toMatchObject({
      columns: ['count'],
      rows: [[6]],
      matched: 6,
      truncated: false,
    });
    expect((await run({ aggregates: [{ fn: 'count', column: 'Amount' }] })).rows).toEqual([[5]]);
    expect((await run({ aggregates: [{ fn: 'count_distinct', column: 'Product' }] })).rows).toEqual(
      [[3]],
    );
  });

  it('sums, averages, and finds extremes of numbers and dates', async () => {
    const { run } = await setup();

    const result = await run({
      aggregates: [
        { fn: 'sum', column: 'Amount' },
        { fn: 'avg', column: 'Amount' },
        { fn: 'min', column: 'Amount' },
        { fn: 'max', column: 'Day' },
      ],
    });
    expect(result.columns).toEqual(['sum(Amount)', 'avg(Amount)', 'min(Amount)', 'max(Day)']);
    expect(result.rows).toEqual([[530.5, 106.1, 40.5, '2024-03-15T10:30:00Z']]);
  });

  it('groups by columns, biggest first, ignoring the case of text', async () => {
    const { run } = await setup();

    const result = await run({
      groupBy: ['Region'],
      aggregates: [{ fn: 'sum', column: 'Amount' }],
    });
    expect(result.columns).toEqual(['Region', 'sum(Amount)']);
    // "West" and "west" are different groups as written; ordering is by the sum.
    expect(result.rows).toEqual([
      ['East', 330],
      ['West', 140.5],
      ['west', 60],
      ['North', null],
    ]);
  });

  it('counts per group when only groupBy is given, and applies orderBy and limit', async () => {
    const { run } = await setup();

    const result = await run({
      groupBy: ['Product'],
      orderBy: [{ by: 'Product', direction: 'desc' }],
      limit: 2,
    });
    expect(result.columns).toEqual(['Product', 'count']);
    expect(result.rows).toEqual([
      ['Tent', 3],
      ['Rope', 1],
    ]);
    expect(result.truncated).toBe(true);
  });

  it('orders by an aggregate and keeps two aggregates of one column apart', async () => {
    const { run } = await setup();

    const result = await run({
      groupBy: ['Product'],
      aggregates: [
        { fn: 'sum', column: 'Amount' },
        { fn: 'count' },
        { fn: 'count', column: 'Amount' },
      ],
      orderBy: [{ by: 'sum(amount)', direction: 'asc' }],
    });
    expect(result.rows).toEqual([
      ['Rope', 40.5, 1, 1],
      ['Boots', 140, 2, 2],
      ['Tent', 350, 3, 2],
    ]);
  });
});

describe('TableService.run: filtering and listing', () => {
  it('filters with numbers, dates and text, all together', async () => {
    const { run } = await setup();

    const result = await run({
      filters: [
        { column: 'Region', op: 'eq', value: 'WEST' },
        { column: 'Amount', op: 'gte', value: 50 },
        { column: 'Day', op: 'lt', value: '2024-03-16' },
      ],
    });
    expect(result.rowNumbers).toEqual([2, 7]);
    expect(result.matched).toBe(2);
    expect(result.columns).toEqual(['Region', 'Product', 'Amount', 'Day', 'Note']);
    expect(result.rows[0]).toEqual(['West', 'Tent', 100, '2024-01-05', 'first']);
  });

  it('supports in, ne (empty values included), is_empty, not_empty and contains', async () => {
    const { run } = await setup();
    const rows = async (filter: TablePlanInput['filters']) =>
      (await run({ filters: filter, select: ['Product'] })).rowNumbers;

    expect(await rows([{ column: 'Product', op: 'in', value: ['rope', 'BOOTS'] }])).toEqual([
      3, 5, 7,
    ]);
    expect(await rows([{ column: 'Amount', op: 'ne', value: 100 }])).toEqual([3, 4, 5, 6, 7]);
    expect(await rows([{ column: 'Amount', op: 'is_empty' }])).toEqual([6]);
    expect(await rows([{ column: 'Note', op: 'not_empty' }])).toEqual([2, 4, 6, 7]);
    expect(await rows([{ column: 'Note', op: 'contains', value: 'ORDER' }])).toEqual([4]);
  });

  it('treats % and _ in contains as plain characters', async () => {
    const { run } = await setup();
    const rows = async (value: string) =>
      (await run({ filters: [{ column: 'Note', op: 'contains', value }] })).rowNumbers;

    expect(await rows('50% off_')).toEqual([7]);
    expect(await rows('%')).toEqual([7]);
    expect(await rows('o_der')).toEqual([]);
  });

  it('ignores select when grouping, since the result is its groups and aggregates', async () => {
    const { run } = await setup();

    const result = await run({
      groupBy: ['Region'],
      select: ['Region', 'count'],
      orderBy: [{ by: 'Region' }],
    });
    expect(result.columns).toEqual(['Region', 'count']);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.slice(0, 2)).toEqual([
      ['East', 2],
      ['North', 1],
    ]);
  });

  it('treats select with aggregates but no groupBy as a listing, and orders by a column for its aggregate', async () => {
    const { run } = await setup();

    const listing = await run({
      aggregates: [{ fn: 'max', column: 'Amount' }],
      select: ['Product', 'Amount'],
      orderBy: [{ by: 'Amount', direction: 'desc' }],
      limit: 1,
    });
    expect(listing.rows).toEqual([['Tent', 250]]);

    // A sum with a stray select stays a sum.
    const sum = await run({ aggregates: [{ fn: 'sum', column: 'Amount' }], select: ['Amount'] });
    expect(sum.rows).toEqual([[530.5]]);

    const grouped = await run({
      groupBy: ['Product'],
      aggregates: [{ fn: 'max', column: 'Amount' }],
      orderBy: [{ by: 'Amount', direction: 'desc' }],
      limit: 1,
    });
    expect(grouped.rows).toEqual([['Tent', 250]]);
  });

  it('lists the selected columns in the order asked, with the limit', async () => {
    const { run } = await setup();

    const result = await run({
      select: ['Product', 'Amount'],
      orderBy: [{ by: 'Amount', direction: 'desc' }],
      limit: 3,
    });
    expect(result.columns).toEqual(['Product', 'Amount']);
    expect(result.rows).toEqual([
      ['Tent', 250],
      ['Tent', 100],
      ['Boots', 80],
    ]);
    expect(result.rowNumbers).toEqual([4, 2, 5]);
    expect(result).toMatchObject({ matched: 6, truncated: true });
  });

  it('compares dates across date-only and date-time values', async () => {
    const { run } = await setup();

    const result = await run({
      filters: [{ column: 'Day', op: 'gt', value: '2024-03-15T00:00:00Z' }],
    });
    expect(result.rowNumbers).toEqual([7]);
  });

  it('works on JSON tables, with absent keys as empty', async () => {
    const { jsonTable } = await import('../ingest');
    const { run } = await setup(jsonTable('[{"a":1,"b":"x"},{"a":2},{"a":3,"b":"x"}]'));

    const result = await run({
      filters: [{ column: 'b', op: 'eq', value: 'x' }],
      aggregates: [{ fn: 'sum', column: 'a' }],
    });
    expect(result.rows).toEqual([[4]]);
  });
});

describe('TableService.run: refusing', () => {
  it('names the real columns when one is unknown, and finds them ignoring case', async () => {
    const { run } = await setup();

    await expect(run({ groupBy: ['Regon'] })).rejects.toThrow(
      /no column "Regon".*"Region", "Product", "Amount"/,
    );
    expect((await run({ groupBy: [' region '] })).columns[0]).toBe('Region');
  });

  it.each<[string, TablePlanInput, RegExp]>([
    ['sum of text', { aggregates: [{ fn: 'sum', column: 'Product' }] }, /text column; sum/],
    ['avg of a date', { aggregates: [{ fn: 'avg', column: 'Day' }] }, /date column; avg/],
    ['sum with no column', { aggregates: [{ fn: 'sum' }] }, /sum needs a column/],
    [
      'gt on text',
      { filters: [{ column: 'Product', op: 'gt', value: 'a' }] },
      /can't be filtered with gt/,
    ],
    [
      'contains on a number',
      { filters: [{ column: 'Amount', op: 'contains', value: '1' }] },
      /number column/,
    ],
    [
      'a text value for a number',
      { filters: [{ column: 'Amount', op: 'gt', value: 'lots' }] },
      /not a number/,
    ],
    [
      'a loose date',
      { filters: [{ column: 'Day', op: 'eq', value: 'last spring' }] },
      /use a date like/,
    ],
    ['no value', { filters: [{ column: 'Amount', op: 'gt' }] }, /needs a value/],
    [
      'a list for eq',
      { filters: [{ column: 'Region', op: 'eq', value: ['a', 'b'] }] },
      /needs one value/,
    ],
    ['an empty in', { filters: [{ column: 'Region', op: 'in', value: [] }] }, /needs a list/],
    [
      'ordering by something not in the result',
      { groupBy: ['Region'], orderBy: [{ by: 'Amount' }] },
      /can't order by "Amount"/,
    ],
    ['the same aggregate twice', { aggregates: [{ fn: 'count' }, { fn: 'count' }] }, /repeated/],
  ])('refuses %s', async (_name, plan, message) => {
    const { run } = await setup();

    const err = await run(plan).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect((err as Error).message).toMatch(message);
  });

  it('rejects plans with unknown keys, too long a limit, or SQL-looking operators', () => {
    expect(() => TablePlan.parse({ sql: 'select 1' })).toThrow();
    expect(() => TablePlan.parse({ limit: 101 })).toThrow();
    expect(() => TablePlan.parse({ filters: [{ column: 'a', op: '; drop table x' }] })).toThrow();
  });

  it('is safe against column names and values that look like SQL', async () => {
    const { run } = await setup(
      csvTable('na"me;--,x\n\'a\',1\n"b\'); drop table source_rows;--",2'),
    );

    const result = await run({
      filters: [{ column: 'na"me;--', op: 'contains', value: "'); drop" }],
    });
    expect(result.rowNumbers).toEqual([3]);
    expect((await run({ aggregates: [{ fn: 'count' }] })).rows).toEqual([[2]]);
  });
});

describe('TableService.run: access', () => {
  it('finds nothing for strangers, non-table sources and unknown ids', async () => {
    const { source } = await setup();
    const stranger = await createUser(admin.db);
    const plain = await setup(null);

    await expect(tables.run(stranger.id, source.id, TablePlan.parse({}))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(plain.run({})).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      tables.run(plain.user.id, '00000000-0000-0000-0000-000000000000', TablePlan.parse({})),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('keeps one source from reading the rows of another in the same cairn', async () => {
    const { user, cairn, source, run } = await setup();
    const other = await sources.create(user.id, cairn.id, {
      kind: 'csv',
      filename: 'o.csv',
      mime: 'text/csv',
      size: 1,
    });
    await sources.complete(user.id, other.id, [], csvTable('Region\nSouth\nSouth'));

    expect((await run({ aggregates: [{ fn: 'count' }] })).rows).toEqual([[6]]);
    expect(
      (await tables.run(user.id, other.id, TablePlan.parse({ aggregates: [{ fn: 'count' }] })))
        .rows,
    ).toEqual([[2]]);
    expect(source.id).not.toBe(other.id);
  });
});
