import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { SourceService, type ChunkInput } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import {
  cairns,
  chunks,
  EMBEDDING_DIMENSIONS,
  queryLog,
  shareRedemptions,
  shares,
  sources,
  withUser,
  type NewShare,
} from '.';

// RLS for sharing, tested below the services: shares are inserted as admin (ShareService comes
// next), everything else runs as cairn_app with a user set, like the api.
const { admin, app } = createTestDbs();
const cairnService = new CairnService(app.db, 'test-embed');
const sourceService = new SourceService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

const file = { kind: 'text', filename: 'notes.txt', mime: 'text/plain', size: 42 } as const;
const chunk = (content: string): ChunkInput => ({
  content,
  location: {},
  embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(i)),
});

async function pgError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => expect.fail('expected the query to fail'),
    (e: unknown) => e as Error & { cause?: Error },
  );
  return err.cause?.message ?? err.message;
}

/** An owner with a cairn holding one ready source, and a second user to share it with. */
async function setup() {
  const owner = await createUser(admin.db);
  const guest = await createUser(admin.db);
  const cairn = await cairnService.create(owner.id, { name: 'Shared' });
  const source = await sourceService.create(owner.id, cairn.id, file);
  await sourceService.complete(owner.id, source.id, [chunk('hello world')]);
  return { owner, guest, cairn, source };
}

async function share(values: Omit<NewShare, 'role' | 'visibility'> & Partial<NewShare>) {
  const [row] = await admin.db
    .insert(shares)
    .values({ role: 'viewer', visibility: 'cited', ...values })
    .returning();
  return row!;
}

const access = (userId: string, cairnId: string) =>
  withUser(app.db, userId, (tx) =>
    tx.execute<{ role: string; visibility: string; share_id: string | null }>(
      sql`select * from cairn_access(${cairnId})`,
    ),
  ).then((rows) => [...rows]);

const redeem = (userId: string, tokenHash: string) =>
  withUser(app.db, userId, (tx) =>
    tx.execute<{ cairn_id: string }>(sql`select * from redeem_share_link(${tokenHash})`),
  ).then((rows) => rows.map((r) => r.cairn_id));

const visible = (userId: string) =>
  withUser(app.db, userId, async (tx) => ({
    cairns: (await tx.select().from(cairns)).length,
    sources: (await tx.select().from(sources)).length,
    chunks: (await tx.select().from(chunks)).length,
  }));

const none = { cairns: 0, sources: 0, chunks: 0 };
const all = { cairns: 1, sources: 1, chunks: 1 };

describe('cairn_access', () => {
  it('reports the owner, and nothing for a stranger or with no user set', async () => {
    const { owner, guest, cairn } = await setup();

    expect(await access(owner.id, cairn.id)).toEqual([
      { role: 'owner', visibility: 'cited', share_id: null },
    ]);
    expect(await access(guest.id, cairn.id)).toEqual([]);
    expect([...(await app.db.execute(sql`select * from cairn_access(${cairn.id})`))]).toEqual([]);
  });

  it('picks the best of several shares: editor before viewer, cited before sealed', async () => {
    const { guest, cairn } = await setup();
    await share({ cairnId: cairn.id, granteeEmail: guest.email, visibility: 'sealed' });
    const cited = await share({ cairnId: cairn.id, linkTokenHash: 'h1' });
    await redeem(guest.id, 'h1');
    expect(await access(guest.id, cairn.id)).toEqual([
      { role: 'viewer', visibility: 'cited', share_id: cited.id },
    ]);

    const editor = await share({ cairnId: cairn.id, linkTokenHash: 'h2', role: 'editor' });
    await redeem(guest.id, 'h2');
    expect((await access(guest.id, cairn.id))[0]?.share_id).toBe(editor.id);
  });

  it("returns the owner's access even when a share also names the owner", async () => {
    const { owner, cairn } = await setup();
    await share({ cairnId: cairn.id, granteeEmail: owner.email, visibility: 'sealed' });

    expect(await access(owner.id, cairn.id)).toEqual([
      { role: 'owner', visibility: 'cited', share_id: null },
    ]);
  });
});

describe('email shares', () => {
  it('let the grantee read the cairn, its sources and chunks, matching email case-insensitively', async () => {
    const { guest, cairn } = await setup();
    const upper = await createUser(admin.db, { email: 'Guest.Person@Example.test' });
    expect(await visible(guest.id)).toEqual(none);

    const s = await share({ cairnId: cairn.id, granteeEmail: guest.email, visibility: 'sealed' });
    await share({ cairnId: cairn.id, granteeEmail: 'guest.person@example.test' });

    expect(await visible(guest.id)).toEqual(all);
    expect(await visible(upper.id)).toEqual(all);
    expect(await access(guest.id, cairn.id)).toEqual([
      { role: 'viewer', visibility: 'sealed', share_id: s.id },
    ]);
  });

  it('grant nothing once revoked or expired', async () => {
    const { guest, cairn } = await setup();
    const s = await share({ cairnId: cairn.id, granteeEmail: guest.email });
    expect(await visible(guest.id)).toEqual(all);

    await admin.db.update(shares).set({ expiresAt: sql`now() - interval '1 second'` });
    expect(await visible(guest.id)).toEqual(none);

    await admin.db.update(shares).set({ expiresAt: sql`now() + interval '1 hour'` });
    expect(await visible(guest.id)).toEqual(all);

    await admin.db
      .update(shares)
      .set({ revokedAt: sql`now()` })
      .where(eq(shares.id, s.id));
    expect(await visible(guest.id)).toEqual(none);
  });

  it('do not leak to other cairns of the same owner', async () => {
    const { owner, guest, cairn } = await setup();
    await cairnService.create(owner.id, { name: 'Private' });
    await share({ cairnId: cairn.id, granteeEmail: guest.email });

    expect((await cairnService.list(guest.id)).map((c) => c.id)).toEqual([cairn.id]);
  });
});

describe('link shares', () => {
  it('grant access only after redemption, and stop when the link is revoked', async () => {
    const { guest, cairn } = await setup();
    const s = await share({ cairnId: cairn.id, linkTokenHash: 'hash' });
    expect(await visible(guest.id)).toEqual(none);

    expect(await redeem(guest.id, 'wrong')).toEqual([]);
    expect(await visible(guest.id)).toEqual(none);

    expect(await redeem(guest.id, 'hash')).toEqual([cairn.id]);
    expect(await redeem(guest.id, 'hash')).toEqual([cairn.id]);
    expect(await visible(guest.id)).toEqual(all);

    await admin.db
      .update(shares)
      .set({ revokedAt: sql`now()` })
      .where(eq(shares.id, s.id));
    expect(await visible(guest.id)).toEqual(none);
    expect(await redeem(guest.id, 'hash')).toEqual([]);
  });

  it('cannot be redeemed after expiry or without a user', async () => {
    const { guest, cairn } = await setup();
    await share({
      cairnId: cairn.id,
      linkTokenHash: 'old',
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(await redeem(guest.id, 'old')).toEqual([]);
    await share({ cairnId: cairn.id, linkTokenHash: 'new' });
    expect([...(await app.db.execute(sql`select * from redeem_share_link('new')`))]).toEqual([]);
    expect(await admin.db.select().from(shareRedemptions)).toEqual([]);
  });

  it('cannot be redeemed by inserting a redemption directly', async () => {
    const { guest, cairn } = await setup();
    const s = await share({ cairnId: cairn.id, linkTokenHash: 'hash' });
    const insert = withUser(app.db, guest.id, (tx) =>
      tx.insert(shareRedemptions).values({ shareId: s.id, userId: guest.id }),
    );

    expect(await pgError(insert)).toMatch(/row-level security/);
  });

  it('let a user leave by deleting their redemption', async () => {
    const { guest, cairn } = await setup();
    await share({ cairnId: cairn.id, linkTokenHash: 'hash' });
    await redeem(guest.id, 'hash');

    await withUser(app.db, guest.id, (tx) => tx.delete(shareRedemptions));
    expect(await visible(guest.id)).toEqual(none);
  });
});

describe('roles', () => {
  it('viewers cannot add, change or delete sources, chunks or the cairn', async () => {
    const { guest, cairn, source } = await setup();
    await share({ cairnId: cairn.id, granteeEmail: guest.email });

    expect(await pgError(sourceService.create(guest.id, cairn.id, file))).toMatch(
      /row-level security/,
    );
    await withUser(app.db, guest.id, async (tx) => {
      await tx.update(sources).set({ filename: 'x' });
      await tx.delete(sources);
      await tx.delete(chunks);
      await tx.update(cairns).set({ name: 'x' });
      await tx.delete(cairns);
    });
    const [after] = await admin.db.select().from(sources);
    expect(after).toMatchObject({ id: source.id, filename: 'notes.txt' });
    expect(await admin.db.select().from(chunks)).toHaveLength(1);
    expect((await admin.db.select().from(cairns))[0]?.name).toBe('Shared');
  });

  it('editors add and process sources but cannot delete them or touch the cairn', async () => {
    const { guest, cairn, source } = await setup();
    await share({ cairnId: cairn.id, granteeEmail: guest.email, role: 'editor' });

    const added = await sourceService.create(guest.id, cairn.id, file);
    await sourceService.markProcessing(guest.id, added.id);
    await sourceService.complete(guest.id, added.id, [chunk('one'), chunk('two')]);
    expect(await admin.db.select().from(chunks)).toHaveLength(3);

    expect(await sourceService.delete(guest.id, source.id)).toBeUndefined();
    await withUser(app.db, guest.id, (tx) => tx.update(cairns).set({ name: 'x' }));
    expect(await admin.db.select().from(sources)).toHaveLength(2);
    expect((await admin.db.select().from(cairns))[0]?.name).toBe('Shared');
  });

  it('an editor whose share is revoked mid-processing can no longer write chunks', async () => {
    const { guest, cairn } = await setup();
    const s = await share({ cairnId: cairn.id, granteeEmail: guest.email, role: 'editor' });
    const added = await sourceService.create(guest.id, cairn.id, file);

    await admin.db
      .update(shares)
      .set({ revokedAt: sql`now()` })
      .where(eq(shares.id, s.id));
    await expect(sourceService.complete(guest.id, added.id, [chunk('late')])).rejects.toThrow();
    expect(await admin.db.select().from(chunks)).toHaveLength(1);
  });
});

describe('RLS on shares', () => {
  it('only the owner sees and manages shares', async () => {
    const { owner, guest, cairn } = await setup();
    await share({ cairnId: cairn.id, granteeEmail: guest.email, role: 'editor' });

    expect(await withUser(app.db, owner.id, (tx) => tx.select().from(shares))).toHaveLength(1);
    expect(await withUser(app.db, guest.id, (tx) => tx.select().from(shares))).toEqual([]);

    const grantSelf = withUser(app.db, guest.id, (tx) =>
      tx
        .insert(shares)
        .values({ cairnId: cairn.id, linkTokenHash: 'x', role: 'editor', visibility: 'cited' }),
    );
    expect(await pgError(grantSelf)).toMatch(/row-level security/);

    await withUser(app.db, owner.id, (tx) =>
      tx
        .insert(shares)
        .values({ cairnId: cairn.id, linkTokenHash: 'y', role: 'viewer', visibility: 'sealed' }),
    );
    expect(await admin.db.select().from(shares)).toHaveLength(2);
  });

  it('lets the owner see who redeemed a link, and other redeemers see only themselves', async () => {
    const { owner, guest, cairn } = await setup();
    const other = await createUser(admin.db);
    await share({ cairnId: cairn.id, linkTokenHash: 'hash' });
    await redeem(guest.id, 'hash');
    await redeem(other.id, 'hash');

    const seen = (userId: string) =>
      withUser(app.db, userId, (tx) => tx.select().from(shareRedemptions)).then((r) =>
        r.map((x) => x.userId).sort(),
      );
    expect(await seen(owner.id)).toEqual([guest.id, other.id].sort());
    expect(await seen(guest.id)).toEqual([guest.id]);
  });

  it('rejects sealed editors, and shares with both or neither grantee', async () => {
    const { cairn } = await setup();

    expect(
      await pgError(
        share({ cairnId: cairn.id, linkTokenHash: 'a', role: 'editor', visibility: 'sealed' }),
      ),
    ).toMatch(/shares_editor_cited_check/);
    expect(await pgError(share({ cairnId: cairn.id }))).toMatch(/shares_grantee_check/);
    expect(
      await pgError(share({ cairnId: cairn.id, granteeEmail: 'a@b.c', linkTokenHash: 'b' })),
    ).toMatch(/shares_grantee_check/);
    expect(await pgError(share({ cairnId: cairn.id, granteeEmail: 'A@b.c' }))).toMatch(
      /shares_email_check/,
    );
  });

  it('allows one live email share per person, and sharing again after revoking', async () => {
    const { cairn } = await setup();
    const first = await share({ cairnId: cairn.id, granteeEmail: 'a@b.c' });

    expect(await pgError(share({ cairnId: cairn.id, granteeEmail: 'a@b.c' }))).toMatch(
      /shares_cairn_email_key/,
    );
    await admin.db
      .update(shares)
      .set({ revokedAt: sql`now()` })
      .where(eq(shares.id, first.id));
    await share({ cairnId: cairn.id, granteeEmail: 'a@b.c' });
  });
});

describe('RLS on query_log with shares', () => {
  it('grantees log their own questions; only the owner reads everyone’s', async () => {
    const { owner, guest, cairn } = await setup();
    const s = await share({ cairnId: cairn.id, granteeEmail: guest.email, visibility: 'sealed' });
    const entry = { cairnId: cairn.id, question: 'q?', chunkCount: 1, latencyMs: 10 };

    await withUser(app.db, owner.id, (tx) =>
      tx.insert(queryLog).values({ ...entry, userId: owner.id }),
    );
    await withUser(app.db, guest.id, (tx) =>
      tx.insert(queryLog).values({ ...entry, userId: guest.id, shareId: s.id }),
    );
    const spoof = withUser(app.db, guest.id, (tx) =>
      tx.insert(queryLog).values({ ...entry, userId: owner.id }),
    );
    expect(await pgError(spoof)).toMatch(/row-level security/);

    expect(await withUser(app.db, owner.id, (tx) => tx.select().from(queryLog))).toHaveLength(2);
    const own = await withUser(app.db, guest.id, (tx) => tx.select().from(queryLog));
    expect(own).toMatchObject([{ userId: guest.id, shareId: s.id }]);
  });
});
