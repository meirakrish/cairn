import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from './cairns';
import { shares } from './db';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from './errors';
import { hashShareToken, ShareService } from './shares';
import { createTestDbs, createUser, resetDb } from './testing';

const { admin, app } = createTestDbs();
const cairnService = new CairnService(app.db, 'test-embed');
const service = new ShareService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

const viewer = { role: 'viewer', visibility: 'sealed' } as const;
const editor = { role: 'editor', visibility: 'cited' } as const;

async function setup() {
  const owner = await createUser(admin.db, { email: 'owner@example.test' });
  const guest = await createUser(admin.db, { email: 'guest@example.test' });
  const cairn = await cairnService.create(owner.id, { name: 'Shared' });
  return { owner, guest, cairn };
}

describe('ShareService.access', () => {
  it('reports owner, share and no access', async () => {
    const { owner, guest, cairn } = await setup();
    const stranger = await createUser(admin.db);
    const share = await service.shareWithEmail(owner.id, cairn.id, guest.email, viewer);

    expect(await service.access(owner.id, cairn.id)).toEqual({
      role: 'owner',
      visibility: 'cited',
      shareId: null,
    });
    expect(await service.access(guest.id, cairn.id)).toEqual({
      role: 'viewer',
      visibility: 'sealed',
      shareId: share.id,
    });
    expect(await service.access(stranger.id, cairn.id)).toBeUndefined();
  });
});

describe('ShareService.shareWithEmail', () => {
  it('normalizes the email and grants access to that account', async () => {
    const { owner, guest, cairn } = await setup();
    const share = await service.shareWithEmail(owner.id, cairn.id, '  Guest@Example.TEST ', editor);

    expect(share).toMatchObject({
      granteeEmail: 'guest@example.test',
      linkTokenHash: null,
      role: 'editor',
      createdBy: owner.id,
    });
    expect((await cairnService.list(guest.id)).map((c) => c.id)).toEqual([cairn.id]);
  });

  it('works before the grantee has ever signed in', async () => {
    const { owner, cairn } = await setup();
    await service.shareWithEmail(owner.id, cairn.id, 'new@example.test', viewer);

    const later = await createUser(admin.db, { email: 'new@example.test' });
    expect((await service.access(later.id, cairn.id))?.role).toBe('viewer');
  });

  it('rejects bad input: not an email, your own email, sealed editors, past expiry', async () => {
    const { owner, cairn } = await setup();
    const share = (email: string, opts: Parameters<ShareService['shareWithEmail']>[3]) =>
      service.shareWithEmail(owner.id, cairn.id, email, opts);

    await expect(share('nope', viewer)).rejects.toThrow(InvalidInputError);
    await expect(share('OWNER@example.test', viewer)).rejects.toThrow(/already own/);
    await expect(share('a@b.c', { role: 'editor', visibility: 'sealed' })).rejects.toThrow(
      /must be cited/,
    );
    await expect(
      share('a@b.c', { ...viewer, expiresAt: new Date(Date.now() - 1) }),
    ).rejects.toThrow(/future/);
    expect(await admin.db.select().from(shares)).toEqual([]);
  });

  it('refuses a second live share for the same email, but allows one after revoking', async () => {
    const { owner, cairn } = await setup();
    const first = await service.shareWithEmail(owner.id, cairn.id, 'a@b.c', viewer);

    await expect(service.shareWithEmail(owner.id, cairn.id, 'A@b.c', editor)).rejects.toThrow(
      ConflictError,
    );
    await service.revoke(owner.id, cairn.id, first.id);
    await service.shareWithEmail(owner.id, cairn.id, 'a@b.c', editor);
  });

  it('is for the owner only: 404 for strangers, forbidden for grantees', async () => {
    const { owner, guest, cairn } = await setup();
    const stranger = await createUser(admin.db);
    await service.shareWithEmail(owner.id, cairn.id, guest.email, editor);

    await expect(service.shareWithEmail(stranger.id, cairn.id, 'a@b.c', viewer)).rejects.toThrow(
      NotFoundError,
    );
    await expect(service.shareWithEmail(guest.id, cairn.id, 'a@b.c', viewer)).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('link shares', () => {
  it('store only the hash of a 32-byte token, which redeems to the cairn', async () => {
    const { owner, guest, cairn } = await setup();
    const { share, token } = await service.createLink(owner.id, cairn.id, viewer);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.linkTokenHash).toBe(hashShareToken(token));
    expect(JSON.stringify(await admin.db.select().from(shares))).not.toContain(token);

    expect(await service.access(guest.id, cairn.id)).toBeUndefined();
    expect(await service.redeem(guest.id, token)).toBe(cairn.id);
    expect(await service.access(guest.id, cairn.id)).toMatchObject({ shareId: share.id });
  });

  it('give nothing for malformed, unknown, revoked or expired tokens', async () => {
    const { owner, guest, cairn } = await setup();
    const { share, token } = await service.createLink(owner.id, cairn.id, viewer);
    const expiring = await service.createLink(owner.id, cairn.id, {
      ...viewer,
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(await service.redeem(guest.id, 'short')).toBeUndefined();
    expect(await service.redeem(guest.id, 'x'.repeat(43))).toBeUndefined();

    await service.revoke(owner.id, cairn.id, share.id);
    expect(await service.redeem(guest.id, token)).toBeUndefined();

    await admin.db
      .update(shares)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(shares.id, expiring.share.id));
    expect(await service.redeem(guest.id, expiring.token)).toBeUndefined();
    expect(await service.access(guest.id, cairn.id)).toBeUndefined();
  });

  it('are created by the owner only', async () => {
    const { owner, guest, cairn } = await setup();
    await service.shareWithEmail(owner.id, cairn.id, guest.email, editor);

    await expect(service.createLink(guest.id, cairn.id, editor)).rejects.toThrow(ForbiddenError);
  });
});

describe('ShareService.list', () => {
  it('lists live shares oldest first, with who opened each link; revoked ones are hidden', async () => {
    const { owner, guest, cairn } = await setup();
    const other = await createUser(admin.db, { email: 'other@example.test', name: 'Other' });
    const email = await service.shareWithEmail(owner.id, cairn.id, 'a@b.c', viewer);
    const link = await service.createLink(owner.id, cairn.id, editor);
    const gone = await service.createLink(owner.id, cairn.id, viewer);
    await service.revoke(owner.id, cairn.id, gone.share.id);
    await service.redeem(guest.id, link.token);
    await service.redeem(other.id, link.token);

    expect(await service.list(owner.id, cairn.id)).toMatchObject([
      { id: email.id, kind: 'email', email: 'a@b.c', redeemedBy: [] },
      {
        id: link.share.id,
        kind: 'link',
        email: null,
        role: 'editor',
        redeemedBy: [
          { id: guest.id, email: 'guest@example.test' },
          { id: other.id, name: 'Other' },
        ],
      },
    ]);
  });

  it('is for the owner only', async () => {
    const { owner, guest, cairn } = await setup();
    await service.shareWithEmail(owner.id, cairn.id, guest.email, viewer);

    await expect(service.list(guest.id, cairn.id)).rejects.toThrow(ForbiddenError);
  });
});

describe('ShareService.revoke', () => {
  it('ends access at once and cannot revoke twice or across cairns', async () => {
    const { owner, guest, cairn } = await setup();
    const elsewhere = await cairnService.create(owner.id, { name: 'Other' });
    const share = await service.shareWithEmail(owner.id, cairn.id, guest.email, viewer);

    await expect(service.revoke(owner.id, elsewhere.id, share.id)).rejects.toThrow(NotFoundError);
    expect((await service.revoke(owner.id, cairn.id, share.id)).revokedAt).toBeInstanceOf(Date);
    expect(await service.access(guest.id, cairn.id)).toBeUndefined();
    await expect(service.revoke(owner.id, cairn.id, share.id)).rejects.toThrow(NotFoundError);
  });

  it('is for the owner only', async () => {
    const { owner, guest, cairn } = await setup();
    const share = await service.shareWithEmail(owner.id, cairn.id, guest.email, editor);

    await expect(service.revoke(guest.id, cairn.id, share.id)).rejects.toThrow(ForbiddenError);
  });
});
