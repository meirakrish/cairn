import { createDb, IngestQueue, S3ObjectStore } from '@cairn/core';
import { Redis } from 'ioredis';
import { createApp } from './app';
import { loadConfig } from './config';
import { EventHub } from './event-hub';

const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);
const storage = new S3ObjectStore(config.s3);
const ingest = new IngestQueue(redis);
// A subscribed ioredis connection can't run other commands, so the hub gets its own.
const subscriber = new Redis(config.redisUrl);
const hub = new EventHub(subscriber);

const server = createApp({ config, db, redis, storage, ingest, hub }).listen(config.port, () => {
  console.log(`api listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    storage.close();
    void Promise.all([closeDb(), ingest.close()])
      .then(() => Promise.all([redis.quit(), subscriber.quit()]))
      .then(() => process.exit(0));
  });
}
