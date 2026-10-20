import { createDb, IngestQueue, S3ObjectStore } from '@cairn/core';
import { Redis } from 'ioredis';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);
const storage = new S3ObjectStore(config.s3);
const ingest = new IngestQueue(redis);

const server = createApp({ config, db, redis, storage, ingest }).listen(config.port, () => {
  console.log(`api listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    storage.close();
    void Promise.all([closeDb(), ingest.close()])
      .then(() => redis.quit())
      .then(() => process.exit(0));
  });
}
