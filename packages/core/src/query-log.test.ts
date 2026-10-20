import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from './cairns';
import { queryLog, withUser } from './db';
import { createTestDbs, createUser, resetDb } from './testing';

const { admin, app } = createTestDbs();
const cairns = new CairnService(app.db, 'm');

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

describe('RLS on query_log', () => {
  it("is readable and writable only through the cairn's visibility", async () => {
    const alice = await createUser(admin.db);
    const bob = await createUser(admin.db);
    const cairn = await cairns.create(alice.id, { name: 'A' });
    const entry = { cairnId: cairn.id, question: 'q?', chunkCount: 8, latencyMs: 1200 };

    await withUser(app.db, alice.id, (tx) =>
      tx.insert(queryLog).values({ ...entry, userId: alice.id }),
    );
    expect(await withUser(app.db, alice.id, (tx) => tx.select().from(queryLog))).toHaveLength(1);
    expect(await withUser(app.db, bob.id, (tx) => tx.select().from(queryLog))).toEqual([]);

    const spoof = withUser(app.db, bob.id, (tx) =>
      tx.insert(queryLog).values({ ...entry, userId: bob.id }),
    );
    await expect(spoof).rejects.toThrow();
    expect(await admin.db.select().from(queryLog)).toHaveLength(1);
  });
});
