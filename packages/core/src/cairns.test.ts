import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from './cairns';
import { cairns, withUser } from './db';
import { createTestDbs, createUser, resetDb } from './testing';

const { admin, app } = createTestDbs();
const service = new CairnService(app.db, 'test-embed');

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

// Drizzle wraps the Postgres error; the RLS message is on the cause.
async function pgError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => expect.fail('expected the query to fail'),
    (e: unknown) => e as Error & { cause?: Error },
  );
  return err.cause?.message ?? err.message;
}

describe('CairnService', () => {
  it('creates cairns with the configured embed model and lists them newest first', async () => {
    const user = await createUser(admin.db);
    const first = await service.create(user.id, { name: 'First' });
    const second = await service.create(user.id, { name: 'Second', description: 'Notes' });

    expect(first).toMatchObject({ ownerId: user.id, embedModel: 'test-embed', description: null });
    expect(second.description).toBe('Notes');
    expect((await service.list(user.id)).map((c) => c.id)).toEqual([second.id, first.id]);
  });
});

describe('RLS on cairns', () => {
  it("hides other users' cairns", async () => {
    const a = await createUser(admin.db);
    const b = await createUser(admin.db);
    await service.create(a.id, { name: 'A' });

    expect(await service.list(a.id)).toHaveLength(1);
    expect(await service.list(b.id)).toEqual([]);
  });

  it('returns no rows when no user is set', async () => {
    const a = await createUser(admin.db);
    await service.create(a.id, { name: 'A' });

    expect(await app.db.select().from(cairns)).toEqual([]);
  });

  it('rejects creating a cairn owned by someone else', async () => {
    const a = await createUser(admin.db);
    const b = await createUser(admin.db);
    const insert = withUser(app.db, b.id, (tx) =>
      tx.insert(cairns).values({ ownerId: a.id, name: 'spoof', embedModel: 'm' }),
    );

    expect(await pgError(insert)).toMatch(/row-level security/);
  });

  it("cannot update or delete another user's cairn", async () => {
    const a = await createUser(admin.db);
    const b = await createUser(admin.db);
    const cairn = await service.create(a.id, { name: 'A' });

    const updated = await withUser(app.db, b.id, (tx) =>
      tx.update(cairns).set({ name: 'pwned' }).where(eq(cairns.id, cairn.id)).returning(),
    );
    const deleted = await withUser(app.db, b.id, (tx) =>
      tx.delete(cairns).where(eq(cairns.id, cairn.id)).returning(),
    );

    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const [row] = await admin.db.select().from(cairns).where(eq(cairns.id, cairn.id));
    expect(row?.name).toBe('A');
  });

  it('rejects handing a cairn to another owner', async () => {
    const a = await createUser(admin.db);
    const b = await createUser(admin.db);
    const cairn = await service.create(a.id, { name: 'A' });
    const update = withUser(app.db, a.id, (tx) =>
      tx.update(cairns).set({ ownerId: b.id }).where(eq(cairns.id, cairn.id)),
    );

    expect(await pgError(update)).toMatch(/row-level security/);
  });
});
