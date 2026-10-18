import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDbs, resetDb } from './testing';
import { getUser, upsertGoogleUser } from './users';

const { admin, app } = createTestDbs();

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

describe('upsertGoogleUser', () => {
  it('creates a user, then refreshes the profile on later logins without changing the id', async () => {
    const profile = { sub: 'sub-1', email: 'old@example.test', name: 'Old', avatarUrl: null };
    const created = await upsertGoogleUser(app.db, profile);
    const updated = await upsertGoogleUser(app.db, {
      ...profile,
      email: 'new@example.test',
      name: 'New',
      avatarUrl: 'https://example.test/a.png',
    });

    expect(updated.id).toBe(created.id);
    expect(await getUser(app.db, created.id)).toMatchObject({
      googleSub: 'sub-1',
      email: 'new@example.test',
      name: 'New',
      avatarUrl: 'https://example.test/a.png',
    });
  });

  it('returns undefined for an unknown id', async () => {
    expect(await getUser(app.db, '00000000-0000-0000-0000-000000000000')).toBeUndefined();
  });
});
