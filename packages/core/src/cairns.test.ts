import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from './cairns';
import { cairns, withUser } from './db';
import { ShareService } from './shares';
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

describe('CairnService.get', () => {
  it("returns the caller's cairn and hides others'", async () => {
    const a = await createUser(admin.db);
    const b = await createUser(admin.db);
    const cairn = await service.create(a.id, { name: 'A' });

    expect((await service.get(a.id, cairn.id))?.name).toBe('A');
    expect(await service.get(b.id, cairn.id)).toBeUndefined();
  });
});

describe('CairnService.update', () => {
  it('renames for the owner only', async () => {
    const owner = await createUser(admin.db);
    const editor = await createUser(admin.db);
    const cairn = await service.create(owner.id, { name: 'A', description: 'old' });
    await new ShareService(app.db).shareWithEmail(owner.id, cairn.id, editor.email, {
      role: 'editor',
      visibility: 'cited',
    });

    const updated = await service.update(owner.id, cairn.id, { name: 'B' });
    expect(updated).toMatchObject({ name: 'B', description: null, access: { role: 'owner' } });
    expect(await service.update(editor.id, cairn.id, { name: 'pwned' })).toBeUndefined();
    expect((await service.get(owner.id, cairn.id))?.name).toBe('B');
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

describe('access on cairns', () => {
  it('lists owned and shared cairns, each with the caller’s role and mode', async () => {
    const owner = await createUser(admin.db);
    const guest = await createUser(admin.db);
    const shared = await service.create(owner.id, { name: 'Shared' });
    const own = await service.create(guest.id, { name: 'Own' });
    const share = await new ShareService(app.db).shareWithEmail(owner.id, shared.id, guest.email, {
      role: 'viewer',
      visibility: 'sealed',
    });

    expect((await service.list(guest.id)).map((c) => [c.name, c.access])).toEqual([
      ['Own', { role: 'owner', visibility: 'cited', shareId: null }],
      ['Shared', { role: 'viewer', visibility: 'sealed', shareId: share.id }],
    ]);
    expect((await service.get(guest.id, shared.id))?.access.role).toBe('viewer');
    expect((await service.get(guest.id, own.id))?.access.role).toBe('owner');
    expect((await service.list(owner.id)).map((c) => c.name)).toEqual(['Shared']);
  });
});
