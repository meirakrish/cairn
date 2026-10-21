import type { Share } from '@cairn/shared';
import { describe, expect, it } from 'vitest';
import { accessLabel, describeShare, expiryDate, sharedBadge } from './share';

const NOW = Date.parse('2026-10-21T12:00:00Z');

const share = (over: Partial<Share> = {}): Share => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'email',
  email: 'ada@example.test',
  role: 'viewer',
  visibility: 'cited',
  expiresAt: null,
  createdAt: '2026-10-20T12:00:00.000Z',
  redeemedBy: [],
  ...over,
});

describe('expiryDate', () => {
  it('counts days from now, or none', () => {
    expect(expiryDate('never', NOW)).toBeNull();
    expect(expiryDate('7d', NOW)).toBe('2026-10-28T12:00:00.000Z');
  });
});

describe('describeShare', () => {
  it('describes email shares by role and mode', () => {
    expect(describeShare(share(), NOW)).toEqual({
      who: 'ada@example.test',
      access: 'can ask · sources shown',
      detail: '',
      expired: false,
    });
    expect(describeShare(share({ visibility: 'sealed' }), NOW).access).toBe(
      'can ask · sources hidden',
    );
    expect(describeShare(share({ role: 'editor' }), NOW).access).toBe('can ask and add files');
  });

  it('lists who opened a link, and marks expiry', () => {
    const link = share({
      kind: 'link',
      email: null,
      expiresAt: '2026-10-21T11:00:00.000Z',
      redeemedBy: [
        { id: '00000000-0000-4000-8000-000000000002', email: 'b@example.test', name: 'Bea' },
        { id: '00000000-0000-4000-8000-000000000003', email: 'c@example.test', name: null },
      ],
    });
    const info = describeShare(link, NOW);
    expect(info.who).toBe('Link');
    expect(info.detail).toMatch(/^Opened by Bea, c@example\.test · Expired /);
    expect(info.expired).toBe(true);
    expect(describeShare({ ...link, redeemedBy: [] }, NOW).detail).toMatch(/^Not opened yet/);
  });
});

describe('sharedBadge', () => {
  it('labels shared cairns only', () => {
    expect(sharedBadge({ role: 'owner', visibility: 'cited' })).toBeUndefined();
    expect(sharedBadge({ role: 'viewer', visibility: 'sealed' })).toBe('Shared · sources hidden');
    expect(sharedBadge({ role: 'editor', visibility: 'cited' })).toBe('Shared · editor');
  });
});

describe('accessLabel', () => {
  it('says what a shared cairn allows', () => {
    expect(accessLabel({ role: 'editor', visibility: 'cited' })).toBe('can add files');
    expect(accessLabel({ role: 'viewer', visibility: 'cited' })).toBe('can ask');
    expect(accessLabel({ role: 'viewer', visibility: 'sealed' })).toBe('answers only');
  });
});
