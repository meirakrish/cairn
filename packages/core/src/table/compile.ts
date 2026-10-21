import { sql, type SQL } from 'drizzle-orm';
import type { TableColumn } from '../db';
import {
  ALLOWED_AGGREGATES,
  ALLOWED_OPS,
  PlanError,
  resolveColumn,
  type AggregateFn,
  type FilterOp,
  type TablePlan,
} from './plan';

export type Cell = string | number | null;

export interface CompiledPlan {
  /** The result's column labels: column names, or aggregates as `sum(Amount)` / `count`. */
  labels: string[];
  /** Selects the rows (one more than the limit, to tell if there are more); listings lead with `row`. */
  rows: SQL;
  /** Counts the rows the filters keep. */
  matched: SQL;
  listing: boolean;
  limit: number;
}

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

// Column names only ever reach the database as bound parameters, never as SQL text.
const text = (name: string) => sql`(data ->> ${name}::text)`;

/** The column's value as its type: numbers and dates compare as such, text as written. */
function typed(column: TableColumn): SQL {
  if (column.type === 'number') return sql`${text(column.name)}::numeric`;
  if (column.type === 'date') return sql`${text(column.name)}::timestamptz`;
  return text(column.name);
}

const COMPARE: Partial<Record<FilterOp, SQL>> = {
  gt: sql`>`,
  gte: sql`>=`,
  lt: sql`<`,
  lte: sql`<=`,
};

/** A filter value as the column's type, or a PlanError saying what is wrong with it. */
function literal(column: TableColumn, value: unknown): SQL {
  if (column.type === 'number') {
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new PlanError(
        `"${column.name}" is a number column; ${JSON.stringify(value)} is not a number`,
      );
    }
    return sql`${n}::numeric`;
  }
  if (column.type === 'date') {
    if (
      typeof value !== 'string' ||
      !ISO_DATE.test(value.trim()) ||
      Number.isNaN(Date.parse(value))
    ) {
      throw new PlanError(
        `"${column.name}" is a date column; use a date like 2024-01-31, not ${JSON.stringify(value)}`,
      );
    }
    return sql`${value.trim()}::timestamptz`;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new PlanError(`"${column.name}" needs a text value, not ${JSON.stringify(value)}`);
  }
  return sql`lower(${String(value)}::text)`;
}

function filterSql(columns: TableColumn[], filter: TablePlan['filters'][number]): SQL {
  const column = resolveColumn(columns, filter.column);
  const { op, value } = filter;
  if (!ALLOWED_OPS[column.type].includes(op)) {
    throw new PlanError(
      `"${column.name}" is a ${column.type} column; it can't be filtered with ${op}`,
    );
  }
  if (op === 'is_empty') return sql`${text(column.name)} is null`;
  if (op === 'not_empty') return sql`${text(column.name)} is not null`;
  if (value === undefined)
    throw new PlanError(`the ${op} filter on "${column.name}" needs a value`);

  // Text is compared ignoring case, since the model rarely copies capitals exactly.
  const left = column.type === 'text' ? sql`lower(${text(column.name)})` : typed(column);
  if (op === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      throw new PlanError(`the in filter on "${column.name}" needs a list of values`);
    }
    return sql`${left} in (${sql.join(
      value.map((v) => literal(column, v)),
      sql`, `,
    )})`;
  }
  if (Array.isArray(value))
    throw new PlanError(`the ${op} filter on "${column.name}" needs one value`);
  if (op === 'contains') {
    const pattern = `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
    return sql`${text(column.name)} ilike ${pattern}::text escape '\\'`;
  }
  if (op === 'eq') return sql`${left} = ${literal(column, value)}`;
  if (op === 'ne') return sql`${left} is distinct from ${literal(column, value)}`;
  return sql`${left} ${COMPARE[op]!} ${literal(column, value)}`;
}

/** What a column shows in results: numbers as numbers, everything else as written. */
const shown = (column: TableColumn): SQL =>
  column.type === 'number' ? sql`(${text(column.name)})::float8` : text(column.name);

// Output positions for group by / order by: integers computed here, so safe as SQL text.
const position = (n: number) => sql.raw(String(n));

/** `a as c0, b as c1`: distinct names, so two `count`s don't collapse into one key. */
const outputs = (items: SQL[]) =>
  sql.join(
    items.map((item, i) => sql`${item} as ${sql.raw(`c${i}`)}`),
    sql`, `,
  );

const ISO_OUT = 'YYYY-MM-DD"T"HH24:MI:SS"Z"';

function aggregateSql(fn: AggregateFn, column: TableColumn | undefined): SQL {
  if (!column) return sql`count(*)::int`;
  const value = typed(column);
  switch (fn) {
    case 'count':
      return sql`count(${value})::int`;
    case 'count_distinct':
      return sql`count(distinct ${value})::int`;
    case 'sum':
      return sql`sum(${value})::float8`;
    case 'avg':
      return sql`avg(${value})::float8`;
    case 'min':
    case 'max': {
      const agg = fn === 'min' ? sql`min(${value})` : sql`max(${value})`;
      if (column.type === 'number') return sql`${agg}::float8`;
      if (column.type === 'date') return sql`to_char(${agg} at time zone 'UTC', ${ISO_OUT}::text)`;
      return agg;
    }
  }
}

const label = (fn: AggregateFn, column: TableColumn | undefined) =>
  column ? `${fn}(${column.name})` : fn;

/**
 * Checks `plan` against the table's columns and builds its SQL. Throws PlanError for anything the
 * table can't answer. The SQL reads only source_rows of `sourceId`; values are always bound.
 */
export function compilePlan(
  sourceId: string,
  columns: TableColumn[],
  plan: TablePlan,
): CompiledPlan {
  const where = sql.join(
    [
      sql`source_id = ${sourceId}::uuid`,
      ...plan.filters.map((filter) => sql`(${filterSql(columns, filter)})`),
    ],
    sql` and `,
  );
  const matched = sql`select count(*)::int from source_rows where ${where}`;
  // A `select` with groupBy or with sum/avg/count has nothing to choose (the result is its groups and
  // aggregates; small models copy the result's labels into it), so it is ignored rather than refused.
  // A `select` with min/max and an ordering but no groupBy is a listing that picked up an aggregate
  // ("the trail with the most cairns" as max + select + orderBy + limit 1): the rows it asks for.
  const asksForRow =
    plan.select.length > 0 &&
    plan.orderBy.length > 0 &&
    plan.aggregates.length > 0 &&
    plan.aggregates.every((a) => a.fn === 'min' || a.fn === 'max');
  const grouped = plan.groupBy.length > 0 || (plan.aggregates.length > 0 && !asksForRow);

  if (!grouped) {
    const shownColumns = plan.select.length
      ? plan.select.map((name) => resolveColumn(columns, name))
      : columns.slice(0, 20);
    const labels = shownColumns.map((c) => c.name);
    const order = orderings(plan, labels, 2);
    return {
      labels,
      listing: true,
      limit: plan.limit,
      matched,
      rows: sql`select ${outputs([sql`"row"`, ...shownColumns.map(shown)])} from source_rows
        where ${where} order by ${order.length ? sql`${sql.join(order, sql`, `)}, "row"` : sql`"row"`} limit ${plan.limit + 1}`,
    };
  }

  const groups = plan.groupBy.map((name) => resolveColumn(columns, name));
  const aggregates = plan.aggregates.length
    ? plan.aggregates.map(({ fn, column }) => {
        const resolved = column === undefined ? undefined : resolveColumn(columns, column);
        if (!resolved && fn !== 'count') throw new PlanError(`${fn} needs a column`);
        if (resolved && !ALLOWED_AGGREGATES[resolved.type].includes(fn)) {
          throw new PlanError(
            `"${resolved.name}" is a ${resolved.type} column; ${fn} doesn't apply to it`,
          );
        }
        return { fn, column: resolved };
      })
    : [{ fn: 'count' as const, column: undefined }];

  const labels = [...groups.map((g) => g.name), ...aggregates.map((a) => label(a.fn, a.column))];
  if (new Set(labels).size !== labels.length)
    throw new PlanError('a column or aggregate is repeated');
  const items = [...groups.map(shown), ...aggregates.map((a) => aggregateSql(a.fn, a.column))];
  // Without an ordering: biggest first by the first aggregate, ties and the rest by group.
  const order = plan.orderBy.length
    ? orderings(plan, labels, 1)
    : groups.length
      ? [sql`${position(groups.length + 1)} desc nulls last`]
      : [];
  const tiebreak = groups.map((_, i) => position(i + 1));
  const orderBy = [...order, ...tiebreak];
  return {
    labels,
    listing: false,
    limit: plan.limit,
    matched,
    rows: sql`select ${outputs(items)} from source_rows where ${where}
      ${
        groups.length
          ? sql`group by ${sql.join(
              groups.map((_, i) => position(i + 1)),
              sql`, `,
            )}`
          : sql``
      }
      ${orderBy.length ? sql`order by ${sql.join(orderBy, sql`, `)}` : sql``} limit ${plan.limit + 1}`,
  };
}

/** `order by` items by output position (`offset` is the position of the first label). */
function orderings(plan: TablePlan, labels: string[], offset: number): SQL[] {
  return plan.orderBy.map(({ by, direction }) => {
    const i = labelIndex(labels, by);
    if (i < 0) {
      throw new PlanError(
        `can't order by "${by}"; the result has ${labels.map((l) => `"${l}"`).join(', ')}`,
      );
    }
    return direction === 'desc'
      ? sql`${position(i + offset)} desc nulls last`
      : sql`${position(i + offset)} asc nulls last`;
  });
}

/**
 * The result column `by` names: exactly, ignoring case, or (for "order by cairns" when the result has
 * max(cairns)) the one aggregate of that column. -1 when there is none or it is ambiguous.
 */
function labelIndex(labels: string[], by: string): number {
  const wanted = by.trim().toLowerCase();
  const exact = labels.findIndex((l) => l === by);
  if (exact >= 0) return exact;
  const loose = labels.findIndex((l) => l.toLowerCase() === wanted);
  if (loose >= 0) return loose;
  const aggregates = labels.flatMap((l, i) => (l.toLowerCase().endsWith(`(${wanted})`) ? [i] : []));
  return aggregates.length === 1 ? aggregates[0]! : -1;
}
