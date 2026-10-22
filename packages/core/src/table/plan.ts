import { z } from 'zod';
import type { ColumnType, TableColumn } from '../db';

export const FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'is_empty',
  'not_empty',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATE_FNS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export const MAX_LIMIT = 100;

const scalar = z.union([z.string(), z.number()]);

/**
 * A query over one table source, written by the model and checked against the table's columns before
 * it runs. All filters apply together (and). With `aggregates` or `groupBy` it returns one row per
 * group (one row in all when there is no groupBy; a groupBy alone counts rows); with neither it
 * lists rows, showing the `select` columns (default: all). `orderBy` names a group column or an
 * aggregate (written `sum(Amount)`, or `count`) in a grouped plan, a column in a listing.
 */
export const TablePlan = z.strictObject({
  filters: z
    .array(
      z.strictObject({
        column: z.string(),
        op: z.enum(FILTER_OPS),
        value: z.union([scalar, z.array(scalar).max(50)]).optional(),
      }),
    )
    .max(10)
    .default([]),
  groupBy: z.array(z.string()).max(3).default([]),
  aggregates: z
    .array(z.strictObject({ fn: z.enum(AGGREGATE_FNS), column: z.string().optional() }))
    .max(5)
    .default([]),
  select: z.array(z.string()).max(20).default([]),
  orderBy: z
    .array(z.strictObject({ by: z.string(), direction: z.enum(['asc', 'desc']).default('asc') }))
    .max(3)
    .default([]),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(20),
});
export type TablePlan = z.output<typeof TablePlan>;
export type TablePlanInput = z.input<typeof TablePlan>;

/** A plan that can't run against its table; the message says why, for the model or the log. */
export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanError';
  }
}

/** The column a name refers to: exact, else ignoring case and surrounding space. */
export function resolveColumn(columns: TableColumn[], name: string): TableColumn {
  const wanted = name.trim().toLowerCase();
  const column =
    columns.find((c) => c.name === name) ?? columns.find((c) => c.name.toLowerCase() === wanted);
  if (!column) {
    const known = columns.map((c) => `"${c.name}"`).join(', ');
    throw new PlanError(`there is no column "${name}"; the columns are ${known}`);
  }
  return column;
}

/** What each column type can be compared, aggregated and filtered with. */
export const ALLOWED_OPS: Record<ColumnType, readonly FilterOp[]> = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'is_empty', 'not_empty'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'is_empty', 'not_empty'],
  text: ['eq', 'ne', 'in', 'contains', 'is_empty', 'not_empty'],
};
export const ALLOWED_AGGREGATES: Record<ColumnType, readonly AggregateFn[]> = {
  number: AGGREGATE_FNS,
  date: ['count', 'count_distinct', 'min', 'max'],
  text: ['count', 'count_distinct', 'min', 'max'],
};
