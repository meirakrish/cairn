// Table-query eval: ingests two tables (trails.csv, orders.jsonl) into their own database, asks
// questions with the real chat model, and checks three things per question: did the router choose
// the table (or passages) it should, did the query return the right values, and does the final
// answer state them. The right values come from the data itself (`truth`), not from a model.
// Run with `pnpm eval:tables` (needs Postgres and Ollama, as for `pnpm dev`; no embeddings are used).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AnswerService,
  CairnService,
  csvTable,
  EMBEDDING_DIMENSIONS,
  IngestService,
  jsonTable,
  MemoryObjectStore,
  RetrievalService,
  SourceService,
  TableQueryService,
  TableService,
  type SourceKind,
  type TableAttempt,
} from '@cairn/core';
import { createTestDbs, createUser, prepareTestDatabase, resetDb } from '@cairn/core/testing';
import { createLlmClient, resolveLlmConfig } from '@meirakrish/llm-kit';
import { fakeEmbedder } from '@meirakrish/llm-kit/testing';
import { TABLE_QUESTIONS, type Row } from './table-questions';

process.env.TEST_DATABASE_NAME ??= 'cairn_eval';

const here = (path: string) => new URL(`../${path}`, import.meta.url);
const FILES: Array<{ filename: string; kind: SourceKind; mime: string }> = [
  { filename: 'trails.csv', kind: 'csv', mime: 'text/csv' },
  { filename: 'orders.jsonl', kind: 'json', mime: 'application/json' },
];

/** Values in the result that equal `want`: numbers within a cent, text ignoring case, dates by prefix. */
function found(cells: Array<string | number | null>, want: string | number): boolean {
  return cells.some((c) =>
    typeof want === 'number'
      ? typeof c === 'number' && Math.abs(c - want) < 0.01
      : typeof c === 'string' && c.toLowerCase().startsWith(want.toLowerCase()),
  );
}

/** Whether the answer text states `want` (numbers without thousands separators, text ignoring case). */
function stated(answer: string, want: string | number): boolean {
  const text = answer.toLowerCase().replace(/(\d),(\d{3})/g, '$1$2');
  if (typeof want === 'string') return text.includes(want.toLowerCase());
  const shown = [String(want), want.toFixed(1), want.toFixed(2), String(Math.round(want))];
  return shown.some((s) => new RegExp(`(?<![\\d.])${s.replace('.', '\\.')}(?![\\d])`).test(text));
}

async function main() {
  await prepareTestDatabase();
  const { admin, app } = createTestDbs();
  try {
    await resetDb(admin.db);
    const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS });
    const llm = await createLlmClient(resolveLlmConfig(), { log: (m) => console.warn(m) });
    // Keep what the router answered (and any retry), to see why a question went to passages.
    const routes: unknown[] = [];
    const structured = llm.structured.bind(llm);
    llm.structured = (async (...args: Parameters<typeof structured>) => {
      const route = await structured(...args);
      routes.push(route);
      return route;
    }) as typeof llm.structured;
    const cairns = new CairnService(app.db, embedder.model);
    const sources = new SourceService(app.db);
    const storage = new MemoryObjectStore();
    const ingest = new IngestService({ cairns, sources, storage, embedder });
    const tables = new TableService(app.db);
    const router = new TableQueryService(app.db, tables, llm);
    const answers = new AnswerService(app.db, new RetrievalService(app.db, embedder), llm, router);

    const user = await createUser(admin.db, { googleSub: 'eval-tables' });
    const cairn = await cairns.create(user.id, { name: 'Table eval' });
    const data = new Map<string, Row[]>();
    for (const file of FILES) {
      const bytes = readFileSync(here(`corpus/${file.filename}`));
      const source = await sources.create(user.id, cairn.id, { ...file, size: bytes.length });
      await storage.put(source.storageKey, bytes, file.mime);
      const result = await ingest.process(user.id, source.id);
      const text = bytes.toString('utf8');
      const table = file.kind === 'csv' ? csvTable(text) : jsonTable(text);
      data.set(
        file.filename,
        table!.rows.map((r) => r.data),
      );
      console.log(
        `  ${file.filename.padEnd(14)} ${JSON.stringify(result)}, ${table!.rows.length} rows`,
      );
    }

    console.log(`\nAsking ${TABLE_QUESTIONS.length} questions with ${llm.model}...\n`);
    interface Outcome {
      id: string;
      style: string;
      routeOk: boolean;
      resultOk?: boolean;
      answerOk?: boolean;
      routeMs: number;
      plan?: string;
      routes: unknown[];
      answer: string;
    }
    const results: Outcome[] = [];
    for (const q of TABLE_QUESTIONS) {
      routes.length = 0;
      const started = Date.now();
      const attempt: TableAttempt | undefined = await router.attempt(user.id, cairn.id, q.question);
      const routeMs = Date.now() - started;
      const routeOk = q.either
        ? true
        : q.table === undefined
          ? !attempt
          : attempt?.source.filename === q.table;

      const values = q.table && q.truth ? q.truth(data.get(q.table)!) : undefined;
      let resultOk: boolean | undefined;
      if (values && attempt && !q.either && routeOk) {
        const cells = [...attempt.result.rows.flat(), ...(attempt.result.rowNumbers ?? [])];
        resultOk = values.every((v) => found(cells, v));
        // A listing must hold exactly the matching rows, and not be cut off.
        if (q.exact)
          resultOk &&= attempt.result.rows.length === values.length && !attempt.result.truncated;
      }
      // Passages questions have no right answer here (nothing is embedded for real); only the route counts.
      let answer = '';
      let answerOk: boolean | undefined;
      if (values) {
        for await (const e of answers.answer(user.id, cairn.id, q.question)) {
          if (e.type === 'delta') answer += e.text;
        }
        answerOk = values.every((v) => stated(answer, v));
      }

      results.push({
        id: q.id,
        style: q.style,
        routeOk,
        resultOk,
        answerOk,
        routeMs,
        plan: attempt?.description,
        routes: [...routes],
        answer: answer.slice(0, 300),
      });
      const mark = (ok: boolean | undefined) => (ok === undefined ? ' - ' : ok ? ' ok' : 'BAD');
      console.log(
        `${q.id.padEnd(18)} route ${mark(routeOk)}  result ${mark(resultOk)}  answer ${mark(answerOk)}  ${String(routeMs).padStart(5)} ms  ${attempt?.description ?? '(passages)'}`,
      );
    }

    const share = (pick: (r: Outcome) => boolean | undefined) => {
      const all = results.map(pick).filter((x) => x !== undefined);
      return `${all.filter(Boolean).length}/${all.length}`;
    };
    console.log(
      `\nroute ${share((r) => r.routeOk)}   result ${share((r) => r.resultOk)}   answer ${share((r) => r.answerOk)}`,
    );
    for (const style of [...new Set(results.map((r) => r.style))]) {
      const of = results.filter((r) => r.style === style);
      const ok = (pick: (r: Outcome) => boolean | undefined) => {
        const all = of.map(pick).filter((x) => x !== undefined);
        return `${all.filter(Boolean).length}/${all.length}`;
      };
      console.log(
        `  ${style.padEnd(10)} route ${ok((r) => r.routeOk)}  result ${ok((r) => r.resultOk)}  answer ${ok((r) => r.answerOk)}`,
      );
    }

    mkdirSync(here('results'), { recursive: true });
    writeFileSync(
      here('results/tables-latest.json'),
      JSON.stringify({ at: new Date().toISOString(), model: llm.model, results }, null, 2),
    );
    console.log('\nWrote packages/eval/results/tables-latest.json');
  } finally {
    await admin.close();
    await app.close();
  }
}

await main();
