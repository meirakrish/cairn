import { createDb } from '@cairn/core';
import { Redis } from 'ioredis';
import { createApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const redis = new Redis(config.redisUrl);

const server = createApp({ config, db, redis }).listen(config.port, () => {
  console.log(`api listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    void Promise.all([closeDb(), redis.quit()]).then(() => process.exit(0));
  });
}
