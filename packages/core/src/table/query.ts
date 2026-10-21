import type { LlmClient } from '@meirakrish/llm-kit';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { sourceRows, sources, withUser, type Db, type SourceKind } from '../db';
import { NotFoundError } from '../errors';
import { PlanError, TablePlan } from './plan';
import {
  describePlan,
  renderResult,
  retryMessages,
  ROUTE_LIMITS,
  Route,
  routerMessages,
  type TableInfo,
} from './prompt';
import type { TableResult, TableService } from './service';

/** Tables the router is shown (the newest), and example rows each. */
export const MAX_ROUTED_TABLES = 5;
export const EXAMPLE_ROWS = 3;
/** The router's plan is refused at most this many times (it is told why each time). */
export const PLAN_ATTEMPTS = 2;

/** A question answered by computing over a table: what ran, and what came back. */
export interface TableAttempt {
  source: { id: string; filename: string; kind: SourceKind; url: string | null };
  plan: TablePlan;
  /** The plan in words, e.g. `rows where Region = "West"; sum(Amount)`. */
  description: string;
  result: TableResult;
  /** The result as text, in place of a passage. */
  text: string;
}

export interface TableQueryOptions {
  signal?: AbortSignal;
}

/**
 * Decides whether a question is better answered by computing over a cairn's tables than from
 * passages, and if so does it. The router (one model call, only in cairns that have a ready table)
 * picks a table and writes a plan; a plan the table can't run is sent back once with the reason.
 * Runs as the user (RLS). attempt() gives undefined whenever the passages should answer instead.
 */
export class TableQueryService {
  constructor(
    private db: Db,
    private tables: TableService,
    private llm: LlmClient,
  ) {}

  async attempt(
    userId: string,
    cairnId: string,
    question: string,
    opts: TableQueryOptions = {},
  ): Promise<TableAttempt | undefined> {
    const tables = await this.list(userId, cairnId);
    if (!tables.length) return undefined;

    let messages = routerMessages(question, tables);
    for (let attempt = 1; ; attempt++) {
      const route = await this.llm.structured(Route, messages, {
        name: 'table_route',
        limits: ROUTE_LIMITS,
        signal: opts.signal,
      });
      if (route.approach === 'passages') return undefined;

      try {
        const table = route.table === undefined ? undefined : tables[route.table - 1];
        if (!table || !route.plan) {
          throw new PlanError('"table" needs the number of a listed table and a plan');
        }
        const result = await this.tables.run(userId, table.sourceId, route.plan);
        const description = describePlan(route.plan);
        return {
          source: {
            id: table.sourceId,
            filename: table.filename,
            kind: table.kind,
            url: table.url,
          },
          plan: route.plan,
          description,
          result,
          text: renderResult(description, result),
        };
      } catch (err) {
        if (err instanceof NotFoundError) return undefined; // the file went away meanwhile
        if (!(err instanceof PlanError)) throw err;
        if (attempt >= PLAN_ATTEMPTS) return undefined;
        messages = retryMessages(messages, route, err.message);
      }
    }
  }

  /** The cairn's newest ready tables with their sizes and a few rows each. */
  private async list(userId: string, cairnId: string): Promise<TableInfo[]> {
    const found = await withUser(this.db, userId, async (tx) => {
      const rows = await tx
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.cairnId, cairnId),
            eq(sources.status, 'ready'),
            isNotNull(sources.columns),
          ),
        )
        .orderBy(sql`${sources.createdAt} desc`)
        .limit(MAX_ROUTED_TABLES);
      const counts = rows.length
        ? await tx
            .select({ sourceId: sourceRows.sourceId, count: sql<number>`count(*)::int` })
            .from(sourceRows)
            .where(eq(sourceRows.cairnId, cairnId))
            .groupBy(sourceRows.sourceId)
        : [];
      return rows.map((s) => ({
        source: s,
        rows: counts.find((c) => c.sourceId === s.id)?.count ?? 0,
      }));
    });

    return Promise.all(
      found.map(async ({ source, rows }): Promise<TableInfo> => {
        const columns = source.columns!;
        const sample = await this.tables.run(
          userId,
          source.id,
          TablePlan.parse({ limit: EXAMPLE_ROWS }),
        );
        return {
          sourceId: source.id,
          filename: source.filename,
          kind: source.kind,
          url: source.url,
          columns,
          rows,
          examples: sample.rows.map((r) =>
            sample.columns
              .flatMap((name, i) => (r[i] === null ? [] : [`${name}: ${r[i]}`]))
              .join('; '),
          ),
        };
      }),
    );
  }
}
