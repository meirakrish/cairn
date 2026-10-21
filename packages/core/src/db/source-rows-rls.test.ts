import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { SourceService } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import { shares, sourceRows, sources, withUser, type NewShare } from '.';

// RLS for source_rows: the same rules as chunks (read where the cairn is visible, write for owners
// and editors), and rows go with their source.
const { admin, app } = createTestDbs();
const cairnService = new CairnService(app.db, 'test-embed');
const sourceService = new SourceService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

const file = { kind: 'csv', filename: 'sales.csv', mime: 'text/csv', size: 42 } as const;
const columns = [
  { name: 'Region', type: 'text' },
  { name: 'Amount', type: 'number' },
] as const;

/** An owner with a cairn and a CSV source holding one row, and a second user. */
async function setup() {
  const owner = await createUser(admin.db);
  const guest = await createUser(admin.db);
  const cairn = await cairnService.create(owner.id, { name: 'Sales' });
  const source = await sourceService.create(owner.id, cairn.id, file);
  await withUser(app.db, owner.id, async (tx) => {
    await tx
      .update(sources)
      .set({ columns: [...columns] })
      .where(eq(sources.id, source.id));
    await tx
      .insert(sourceRows)
      .values({
        cairnId: cairn.id,
        sourceId: source.id,
        row: 2,
        data: { Region: 'West', Amount: 5 },
      });
  });
  return { owner, guest, cairn, source };
}

async function share(values: Omit<NewShare, 'role' | 'visibility'> & Partial<NewShare>) {
  await admin.db.insert(shares).values({ role: 'viewer', visibility: 'cited', ...values });
}

const rowCount = (userId: string) =>
  withUser(app.db, userId, async (tx) => (await tx.select().from(sourceRows)).length);

const insertRow = (userId: string, cairnId: string, sourceId: string, row: number) =>
  withUser(app.db, userId, (tx) =>
    tx.insert(sourceRows).values({ cairnId, sourceId, row, data: { Region: 'East' } }),
  );

describe('source_rows', () => {
  it('keeps the columns on the source and the typed values in the row', async () => {
    const { owner, source } = await setup();

    const [row] = await withUser(app.db, owner.id, (tx) => tx.select().from(sourceRows));
    const [saved] = await withUser(app.db, owner.id, (tx) =>
      tx.select().from(sources).where(eq(sources.id, source.id)),
    );
    expect(row).toMatchObject({ row: 2, data: { Region: 'West', Amount: 5 } });
    expect(saved?.columns).toEqual(columns);
  });

  it('are visible to the owner and to grantees, even sealed ones, but not to strangers', async () => {
    const { owner, guest, cairn } = await setup();
    expect(await rowCount(owner.id)).toBe(1);
    expect(await rowCount(guest.id)).toBe(0);

    await share({ cairnId: cairn.id, granteeEmail: guest.email, visibility: 'sealed' });
    expect(await rowCount(guest.id)).toBe(1);
  });

  it('can be written by owners and editors, not viewers or strangers', async () => {
    const { owner, guest, cairn, source } = await setup();
    await insertRow(owner.id, cairn.id, source.id, 3);

    await expect(insertRow(guest.id, cairn.id, source.id, 4)).rejects.toThrow();
    await share({ cairnId: cairn.id, granteeEmail: guest.email });
    await expect(insertRow(guest.id, cairn.id, source.id, 4)).rejects.toThrow();

    await admin.db.update(shares).set({ revokedAt: new Date() });
    await share({ cairnId: cairn.id, granteeEmail: guest.email, role: 'editor' });
    await insertRow(guest.id, cairn.id, source.id, 4);
    expect(await rowCount(owner.id)).toBe(3);
  });

  it('refuses a row filed under another cairn than its source', async () => {
    const { owner, source } = await setup();
    const other = await cairnService.create(owner.id, { name: 'Other' });

    await expect(insertRow(owner.id, other.id, source.id, 3)).rejects.toThrow();
  });

  it('go when their source is deleted', async () => {
    const { owner, source } = await setup();

    await sourceService.delete(owner.id, source.id);
    expect(await rowCount(owner.id)).toBe(0);
  });
});
