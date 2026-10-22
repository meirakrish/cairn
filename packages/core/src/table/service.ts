import { eq, sql } from 'drizzle-orm';
import { sources, withUser, type Db, type TableColumn } from '../db';
import { NotFoundError } from '../errors';
import { compilePlan, type Cell } from './compile';
import type { TablePlan } from './plan';

/** Longest a table query may run. */
export const STATEMENT_TIMEOUT_MS = 5_000;

export interface TableResult {
  sourceId: string;
  /** Column names, or aggregates written `sum(Amount)` / `count`. */
  columns: string[];
  rows: Cell[][];
  /** For a listing: the row number of each row (spreadsheet row, JSONL line, JSON index). */
  rowNumbers?: number[];
  /** How many rows the filters kept, before grouping or the limit. */
  matched: number;
  /** There were more rows than the limit. */
  truncated: boolean;
}

/**
 * Runs query plans over the rows of one table source, as the user (RLS), so a source they can't see
 * is a NotFoundError. The plan is checked against the source's columns first (PlanError).
 */
export class TableService {
  constructor(private db: Db) {}

  async run(userId: string, sourceId: string, plan: TablePlan): Promise<TableResult> {
    return withUser(this.db, userId, async (tx) => {
      const [source] = await tx
        .select({ columns: sources.columns })
        .from(sources)
        .where(eq(sources.id, sourceId));
      const columns: TableColumn[] | null | undefined = source?.columns;
      if (!columns) throw new NotFoundError('table');

      const compiled = compilePlan(sourceId, columns, plan);
      // Both settings are local to this transaction. Dates compare in UTC, whatever the server's zone.
      await tx.execute(
        sql`select set_config('statement_timeout', ${String(STATEMENT_TIMEOUT_MS)}, true)`,
      );
      await tx.execute(sql`select set_config('timezone', 'UTC', true)`);

      const rows = await tx.execute<Record<string, Cell>>(compiled.rows);
      const [{ count: matched } = { count: 0 }] = await tx.execute<{ count: number }>(
        compiled.matched,
      );
      const truncated = rows.length > compiled.limit;
      const kept = [...rows].slice(0, compiled.limit).map((r) => Object.values(r));

      return {
        sourceId,
        columns: compiled.labels,
        ...(compiled.listing
          ? { rows: kept.map((r) => r.slice(1)), rowNumbers: kept.map((r) => Number(r[0])) }
          : { rows: kept }),
        matched,
        truncated,
      };
    });
  }
}
