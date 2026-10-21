import type { Cairn, Share } from '@cairn/shared';

export type Expiry = 'never' | '1d' | '7d' | '30d';

export const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '1d', label: 'In 1 day' },
  { value: '7d', label: 'In 7 days' },
  { value: '30d', label: 'In 30 days' },
];

const DAYS: Record<Exclude<Expiry, 'never'>, number> = { '1d': 1, '7d': 7, '30d': 30 };

/** The ISO expiry for a choice, counted from `now`; null for never. */
export function expiryDate(expiry: Expiry, now = Date.now()): string | null {
  return expiry === 'never' ? null : new Date(now + DAYS[expiry] * 86_400_000).toISOString();
}

const ROLE_LABEL = { viewer: 'can ask', editor: 'can ask and add files' } as const;
const VISIBILITY_LABEL = { cited: 'sources shown', sealed: 'sources hidden' } as const;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** How a share reads in the owner's list. */
export function describeShare(
  share: Share,
  now = Date.now(),
): { who: string; access: string; detail: string; expired: boolean } {
  const who = share.kind === 'email' ? share.email! : 'Link';
  const access =
    share.role === 'editor'
      ? ROLE_LABEL.editor
      : `${ROLE_LABEL.viewer} · ${VISIBILITY_LABEL[share.visibility]}`;
  const parts: string[] = [];
  if (share.kind === 'link') {
    const names = share.redeemedBy.map((u) => u.name ?? u.email);
    parts.push(names.length ? `Opened by ${names.join(', ')}` : 'Not opened yet');
  }
  const expired = share.expiresAt !== null && Date.parse(share.expiresAt) <= now;
  if (share.expiresAt) {
    const when = dateFormat.format(new Date(share.expiresAt));
    parts.push(expired ? `Expired ${when}` : `Expires ${when}`);
  }
  return { who, access, detail: parts.join(' · '), expired };
}

/** The badge for a cairn shared with the caller; undefined for their own. */
export function sharedBadge(cairn: Pick<Cairn, 'role' | 'visibility'>): string | undefined {
  if (cairn.role === 'owner') return undefined;
  if (cairn.role === 'editor') return 'Shared · editor';
  return cairn.visibility === 'sealed' ? 'Shared · sources hidden' : 'Shared · viewer';
}

/** The short access note beside a shared cairn in the sidebar. */
export function accessLabel(cairn: Pick<Cairn, 'role' | 'visibility'>): string {
  if (cairn.role === 'editor') return 'can add files';
  return cairn.visibility === 'sealed' ? 'answers only' : 'can ask';
}
