import {
  CairnService,
  createDb,
  INGEST_QUEUE,
  IngestService,
  redisSourcePublisher,
  S3ObjectStore,
  SourceService,
  type IngestJob,
} from '@cairn/core';
import { createEmbedder, describeLlmError } from '@meirakrish/llm-kit';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from './config';
import { createProcessor } from './processor';

const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const storage = new S3ObjectStore(config.s3);
const embedder = await createEmbedder(config.embed, {
  overflowHint: 'lower the chunk size',
  log: (msg) => console.warn(msg),
});
// Status changes go to the cairn's Redis channel, which the api streams to browsers.
const publisher = new Redis(config.redisUrl);
const sources = new SourceService(db, { onChange: redisSourcePublisher(publisher) });
// The cairns' embed_model must match; the api stamps it from EMBED_MODEL too.
const ingest = new IngestService({
  cairns: new CairnService(db, embedder.model),
  sources,
  storage,
  embedder,
});

// BullMQ workers block on Redis, so they need a connection that never gives up on a command.
const connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const worker = new Worker<IngestJob>(INGEST_QUEUE, createProcessor(ingest, sources), {
  connection,
  concurrency: config.concurrency,
  // Embedding a large file takes a while; the lock is renewed, this only bounds a stuck job.
  lockDuration: 120_000,
});
worker.on('error', (err) => console.error('worker error:', err));

console.log(
  `worker listening on queue "${INGEST_QUEUE}" (${config.embed.provider} ${embedder.model}, ${config.concurrency} at a time)`,
);
// Not fatal: jobs retry until the embedder is reachable. Loading the model also takes the first-call delay.
embedder.embed(['ping']).then(
  () => console.log('embedder ready'),
  (err: unknown) => console.warn(`embedder not reachable yet: ${describeLlmError(err)}`),
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void worker
      .close()
      .then(() => Promise.all([closeDb(), connection.quit(), publisher.quit()]))
      .then(() => storage.close())
      .then(() => process.exit(0));
  });
}
