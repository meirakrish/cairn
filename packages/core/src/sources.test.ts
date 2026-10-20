import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from './cairns';
import { cairns, chunks, EMBEDDING_DIMENSIONS, sources, withUser } from './db';
import { NotFoundError } from './errors';
import { SourceService, type ChunkInput } from './sources';
import { createTestDbs, createUser, resetDb } from './testing';

const { admin, app } = createTestDbs();
const cairnService = new CairnService(app.db, 'test-embed');
const service = new SourceService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

const file = { kind: 'text', filename: 'notes.txt', mime: 'text/plain', size: 42 } as const;

function vec(seed: number, dims = EMBEDDING_DIMENSIONS): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed + i));
}

const chunk = (content: string, seed = 1): ChunkInput => ({
  content,
  location: { offset: seed },
  embedding: vec(seed),
});

// Drizzle wraps the Postgres error; the useful message is on the cause.
async function pgError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => expect.fail('expected the query to fail'),
    (e: unknown) => e as Error & { cause?: Error },
  );
  return err.cause?.message ?? err.message;
}

async function ownerWithCairn() {
  const user = await createUser(admin.db);
  const cairn = await cairnService.create(user.id, { name: 'C' });
  return { user, cairn };
}

describe('SourceService', () => {
  it('creates pending sources with a storage key under their cairn, newest first', async () => {
    const { user, cairn } = await ownerWithCairn();
    const first = await service.create(user.id, cairn.id, file);
    const second = await service.create(user.id, cairn.id, { ...file, filename: 'b.txt' });

    expect(first).toMatchObject({
      status: 'pending',
      createdBy: user.id,
      storageKey: `cairns/${cairn.id}/sources/${first.id}`,
    });
    expect((await service.list(user.id, cairn.id)).map((s) => s.id)).toEqual([second.id, first.id]);
  });

  it("refuses to create a source in someone else's cairn", async () => {
    const { cairn } = await ownerWithCairn();
    const other = await createUser(admin.db);

    await expect(service.create(other.id, cairn.id, file)).rejects.toBeInstanceOf(NotFoundError);
    expect(await admin.db.select().from(sources)).toEqual([]);
  });

  it('completes a source: numbered chunks, full-text index, status ready', async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    await service.markProcessing(user.id, source.id);

    const ready = await service.complete(user.id, source.id, [
      chunk('Granite boulders mark the trail', 1),
      chunk('Cairns guide hikers above the tree line', 2),
    ]);

    expect(ready).toMatchObject({ status: 'ready', error: null });
    const stored = await service.listChunks(user.id, source.id);
    expect(stored.map((c) => [c.ordinal, c.content, c.location])).toEqual([
      [0, 'Granite boulders mark the trail', { offset: 1 }],
      [1, 'Cairns guide hikers above the tree line', { offset: 2 }],
    ]);
    const hits = await admin.db
      .select({ ordinal: chunks.ordinal })
      .from(chunks)
      .where(sql`${chunks.tsv} @@ plainto_tsquery('simple', 'hikers')`);
    expect(hits).toEqual([{ ordinal: 1 }]);
  });

  it('replaces chunks when a source is processed again', async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    await service.complete(user.id, source.id, [chunk('old 1'), chunk('old 2')]);
    await service.complete(user.id, source.id, [chunk('new')]);

    expect((await service.listChunks(user.id, source.id)).map((c) => c.content)).toEqual(['new']);
  });

  it('claims pending and failed sources for processing, but not ready ones', async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);

    expect((await service.markProcessing(user.id, source.id))?.status).toBe('processing');
    expect(await service.fail(user.id, source.id, 'x'.repeat(2000))).toMatchObject({
      status: 'failed',
      error: 'x'.repeat(500),
    });
    expect(await service.markProcessing(user.id, source.id)).toMatchObject({
      status: 'processing',
      error: null,
    });
    await service.complete(user.id, source.id, []);
    expect(await service.markProcessing(user.id, source.id)).toBeUndefined();
  });

  it('deleting a source deletes its chunks and returns the row', async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    await service.complete(user.id, source.id, [chunk('a')]);

    expect((await service.delete(user.id, source.id))?.storageKey).toBe(source.storageKey);
    expect(await admin.db.select().from(chunks)).toEqual([]);
  });

  it('deleting a cairn deletes its sources and chunks', async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    await service.complete(user.id, source.id, [chunk('a')]);

    await withUser(app.db, user.id, (tx) => tx.delete(cairns).where(eq(cairns.id, cairn.id)));
    expect(await admin.db.select().from(sources)).toEqual([]);
    expect(await admin.db.select().from(chunks)).toEqual([]);
  });

  it(`rejects embeddings that are not ${EMBEDDING_DIMENSIONS}-dimensional`, async () => {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    const bad = { ...chunk('a'), embedding: vec(1, 768) };

    expect(await pgError(service.complete(user.id, source.id, [bad]))).toMatch(
      /expected 1024 dimensions/,
    );
    expect((await service.get(user.id, source.id))?.status).toBe('pending');
  });
});

describe('RLS on sources and chunks', () => {
  async function aliceWithChunk() {
    const { user, cairn } = await ownerWithCairn();
    const source = await service.create(user.id, cairn.id, file);
    await service.complete(user.id, source.id, [chunk('secret')]);
    return { alice: user, cairn, source, bob: await createUser(admin.db) };
  }

  it("hides other users' sources and chunks", async () => {
    const { cairn, source, bob } = await aliceWithChunk();

    expect(await service.list(bob.id, cairn.id)).toEqual([]);
    expect(await service.get(bob.id, source.id)).toBeUndefined();
    expect(await service.listChunks(bob.id, source.id)).toEqual([]);
    expect(await withUser(app.db, bob.id, (tx) => tx.select().from(chunks))).toEqual([]);
  });

  it('returns nothing when no user is set', async () => {
    await aliceWithChunk();

    expect(await app.db.select().from(sources)).toEqual([]);
    expect(await app.db.select().from(chunks)).toEqual([]);
  });

  it("cannot change or delete another user's source", async () => {
    const { source, bob } = await aliceWithChunk();

    expect(await service.delete(bob.id, source.id)).toBeUndefined();
    expect(await service.fail(bob.id, source.id, 'pwned')).toBeUndefined();
    expect(await service.markProcessing(bob.id, source.id)).toBeUndefined();
    await expect(service.complete(bob.id, source.id, [])).rejects.toBeInstanceOf(NotFoundError);

    const [row] = await admin.db.select().from(sources).where(eq(sources.id, source.id));
    expect(row?.status).toBe('ready');
    expect(await admin.db.select().from(chunks)).toHaveLength(1);
  });

  it("rejects writing sources or chunks into another user's cairn", async () => {
    const { cairn, source, bob } = await aliceWithChunk();
    const insertSource = withUser(app.db, bob.id, (tx) =>
      tx.insert(sources).values({ ...file, cairnId: cairn.id, storageKey: 'spoof' }),
    );
    const insertChunk = withUser(app.db, bob.id, (tx) =>
      tx.insert(chunks).values({
        cairnId: cairn.id,
        sourceId: source.id,
        ordinal: 99,
        content: 'injected',
        embedding: vec(9),
      }),
    );

    expect(await pgError(insertSource)).toMatch(/row-level security/);
    expect(await pgError(insertChunk)).toMatch(/row-level security/);
  });

  it("keeps a chunk in its source's cairn", async () => {
    const { source } = await aliceWithChunk();
    const { user: bob, cairn: bobsCairn } = await ownerWithCairn();
    // Bob can write to his own cairn, but not attach Alice's source to it.
    const insert = withUser(app.db, bob.id, (tx) =>
      tx.insert(chunks).values({
        cairnId: bobsCairn.id,
        sourceId: source.id,
        ordinal: 99,
        content: 'x',
        embedding: vec(1),
      }),
    );

    expect(await pgError(insert)).toMatch(/chunks_source_fk/);
  });
});

describe('SourceService change notifications', () => {
  it('reports each committed change, and nothing for no-ops', async () => {
    const changes: string[] = [];
    const notifying = new SourceService(app.db, {
      onChange: (c) => void changes.push(`${c.kind}:${c.source.status}`),
    });
    const { user, cairn } = await ownerWithCairn();
    const other = await createUser(admin.db);

    const source = await notifying.create(user.id, cairn.id, file);
    await notifying.markProcessing(user.id, source.id);
    await notifying.fail(user.id, source.id, 'x');
    await notifying.complete(user.id, source.id, [chunk('a')]);
    await notifying.markProcessing(user.id, source.id); // ready: no-op
    await notifying.delete(other.id, source.id); // not visible: no-op
    await notifying.delete(user.id, source.id);

    expect(changes).toEqual([
      'changed:pending',
      'changed:processing',
      'changed:failed',
      'changed:ready',
      'deleted:ready',
    ]);
  });

  it('does not fail the change when the listener throws', async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const notifying = new SourceService(app.db, {
        onChange: () => {
          throw new Error('redis down');
        },
      });
      const { user, cairn } = await ownerWithCairn();
      const source = await notifying.create(user.id, cairn.id, file);
      expect((await service.get(user.id, source.id))?.status).toBe('pending');
    } finally {
      console.warn = warn;
    }
  });
});
