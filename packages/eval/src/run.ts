// Retrieval eval: ingests the fixed corpus into its own database (cairn_eval) with the real embedder
// (and the chat model's vision for the image and the scanned PDF), asks every question under several
// search settings, and reports recall@k and MRR.
// Run with `pnpm eval` (needs Postgres, Redis and Ollama, as for `pnpm dev`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CairnService,
  EMBEDDING_DIMENSIONS,
  IngestService,
  MemoryObjectStore,
  RetrievalService,
  SourceService,
  type SearchOptions,
  type SourceKind,
} from '@cairn/core';
import {
  createTestDbs,
  createUser,
  makePdf,
  prepareTestDatabase,
  resetDb,
} from '@cairn/core/testing';
import {
  createEmbedder,
  createLlmClient,
  resolveEmbedConfig,
  resolveLlmConfig,
} from '@meirakrish/llm-kit';
import sharp from 'sharp';
import { questionRank, summarize, type Question } from './metrics';

process.env.TEST_DATABASE_NAME ??= 'cairn_eval';

const here = (path: string) => new URL(`../${path}`, import.meta.url);
const KS = [1, 3, 8];
const LIMIT = Math.max(...KS);

// `hybrid` is what the app uses (keyword weight DEFAULT_KEYWORD_WEIGHT); the rest are for comparison.
const CONFIGS: Array<{ name: string } & SearchOptions> = [
  { name: 'hybrid', mode: 'hybrid' },
  { name: 'hybrid, equal weights', mode: 'hybrid', keywordWeight: 1 },
  { name: 'vector', mode: 'vector' },
  { name: 'keyword', mode: 'keyword' },
  { name: 'hybrid, no instruction', mode: 'hybrid', queryInstruction: false },
  { name: 'vector, no instruction', mode: 'vector', queryInstruction: false },
];

/** The US Constitution as a PDF: lines wrapped at 90 characters, 50 lines per page. */
function constitutionPdf(): Uint8Array {
  const lines = readFileSync(here('corpus/constitution.txt'), 'utf8')
    .split('\n')
    .flatMap((line) => line.match(/.{1,90}(\s|$)|\S+/g) ?? ['']);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50).join('\n'));
  return makePdf(pages);
}

/** The trail sign SVG as a PNG photo stand-in. */
const trailheadPng = () =>
  sharp(readFileSync(here('corpus/trailhead.svg')))
    .png()
    .toBuffer();

/** The minutes SVG as a slightly rotated, lossy JPEG scan: the only page of a PDF without text. */
async function minutesScanPdf(): Promise<Uint8Array> {
  const jpeg = await sharp(readFileSync(here('corpus/minutes.svg')))
    .rotate(0.6, { background: '#f3efe4' })
    .jpeg({ quality: 70 })
    .toBuffer();
  const { width, height } = await sharp(jpeg).metadata();
  return makePdf([{ jpeg, width: width!, height: height! }]);
}

const CORPUS: Array<{
  filename: string;
  kind: SourceKind;
  mime: string;
  data: () => Uint8Array | Promise<Uint8Array>;
}> = [
  { filename: 'constitution.pdf', kind: 'pdf', mime: 'application/pdf', data: constitutionPdf },
  {
    filename: 'elements-of-style.txt',
    kind: 'text',
    mime: 'text/plain',
    data: () => readFileSync(here('corpus/elements-of-style.txt')),
  },
  {
    filename: 'design.md',
    kind: 'markdown',
    mime: 'text/markdown',
    data: () => readFileSync(here('corpus/design.md')),
  },
  {
    filename: 'llm-kit.md',
    kind: 'markdown',
    mime: 'text/markdown',
    data: () => readFileSync(here('corpus/llm-kit.md')),
  },
  {
    filename: 'trails.csv',
    kind: 'csv',
    mime: 'text/csv',
    data: () => readFileSync(here('corpus/trails.csv')),
  },
  {
    filename: 'shop.json',
    kind: 'json',
    mime: 'application/json',
    data: () => readFileSync(here('corpus/shop.json')),
  },
  { filename: 'trailhead.png', kind: 'image', mime: 'image/png', data: trailheadPng },
  {
    filename: 'minutes-scan.pdf',
    kind: 'pdf',
    mime: 'application/pdf',
    data: minutesScanPdf,
  },
];

const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(5);
const fmtRank = (r: number) => (r === Infinity ? '  -' : String(r).padStart(3));

async function main() {
  const { questions } = JSON.parse(readFileSync(here('questions.json'), 'utf8')) as {
    questions: Question[];
  };
  await prepareTestDatabase();
  const { admin, app } = createTestDbs();
  try {
    await resetDb(admin.db);
    const embedder = await createEmbedder(resolveEmbedConfig({ dimensions: EMBEDDING_DIMENSIONS }));
    const cairns = new CairnService(app.db, embedder.model);
    const sources = new SourceService(app.db);
    const storage = new MemoryObjectStore();
    const vision = await createLlmClient(resolveLlmConfig(), { log: (m) => console.warn(m) });
    const ingest = new IngestService({ cairns, sources, storage, embedder, vision });
    const retrieval = new RetrievalService(app.db, embedder);

    const user = await createUser(admin.db, { googleSub: 'eval' });
    const cairn = await cairns.create(user.id, { name: 'Eval corpus' });
    console.log(`Ingesting the corpus with ${embedder.model} (vision: ${vision.model})...`);
    for (const doc of CORPUS) {
      const data = await doc.data();
      const source = await sources.create(user.id, cairn.id, { ...doc, size: data.length });
      await storage.put(source.storageKey, data, doc.mime);
      const started = Date.now();
      const result = await ingest.process(user.id, source.id);
      console.log(
        `  ${doc.filename.padEnd(22)} ${JSON.stringify(result)} in ${Date.now() - started} ms`,
      );
    }

    const results = [];
    for (const config of CONFIGS) {
      const perQuestion: Array<{ id: string; style: Question['style']; rank: number }> = [];
      for (const q of questions) {
        const hits = await retrieval.search(user.id, cairn.id, q.question, {
          ...config,
          limit: LIMIT,
        });
        perQuestion.push({ id: q.id, style: q.style, rank: questionRank(hits, q) });
      }
      const byStyle = Object.fromEntries(
        (['direct', 'paraphrase', 'exact'] as const).map((style) => [
          style,
          summarize(
            perQuestion.filter((r) => r.style === style).map((r) => r.rank),
            KS,
          ),
        ]),
      );
      results.push({
        config,
        overall: summarize(
          perQuestion.map((r) => r.rank),
          KS,
        ),
        byStyle,
        perQuestion,
      });
    }

    console.log(`\n${questions.length} questions, top ${LIMIT} chunks\n`);
    console.log(`${'setting'.padEnd(24)}   R@1   R@3   R@8   MRR | R@8 direct paraphrase exact`);
    for (const r of results) {
      const s = r.overall;
      console.log(
        `${r.config.name.padEnd(24)} ${pct(s.recall[1]!)} ${pct(s.recall[3]!)} ${pct(s.recall[8]!)} ${s.mrr.toFixed(2).padStart(5)} |` +
          `     ${pct(r.byStyle.direct!.recall[8]!)}      ${pct(r.byStyle.paraphrase!.recall[8]!)} ${pct(r.byStyle.exact!.recall[8]!)}`,
      );
    }

    // The app's setting, split by the kind of file each question's passage is in.
    const kindOf = new Map(
      CORPUS.map((d) => [d.filename, d.filename.endsWith('-scan.pdf') ? 'scan' : d.kind]),
    );
    const hybrid = results[0]!;
    console.log(`\n${hybrid.config.name} by file type:  R@1   R@3   R@8   MRR  questions`);
    for (const kind of [...new Set(kindOf.values())]) {
      const ranks = hybrid.perQuestion
        .filter((_, i) => kindOf.get(questions[i]!.expect[0]!.source) === kind)
        .map((r) => r.rank);
      const s = summarize(ranks, KS);
      console.log(
        `  ${kind.padEnd(22)} ${pct(s.recall[1]!)} ${pct(s.recall[3]!)} ${pct(s.recall[8]!)} ${s.mrr.toFixed(2).padStart(5)}  ${ranks.length}`,
      );
    }

    console.log('\nRank of the expected passage per question (- = not in the top 8):\n');
    console.log(
      `${'question'.padEnd(22)} ${results.map((r) => r.config.name.split(',')[0]!.slice(0, 7).padStart(7)).join(' ')}`,
    );
    for (const [i, q] of questions.entries()) {
      const ranks = results.map((r) => fmtRank(r.perQuestion[i]!.rank).padStart(7));
      console.log(`${q.id.padEnd(22)} ${ranks.join(' ')}`);
    }

    mkdirSync(here('results'), { recursive: true });
    const out = {
      at: new Date().toISOString(),
      model: embedder.model,
      questions: questions.length,
      results,
    };
    writeFileSync(
      here('results/latest.json'),
      JSON.stringify(out, (_k, v) => (v === Infinity ? null : v), 2),
    );
    console.log('\nWrote packages/eval/results/latest.json');
  } finally {
    await admin.close();
    await app.close();
  }
}

await main();
