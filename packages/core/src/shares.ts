import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  shareRedemptions,
  shares,
  users,
  withUser,
  type CairnRole,
  type Db,
  type Share,
  type ShareRole,
  type ShareVisibility,
  type Tx,
} from './db';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from './errors';

/** What the caller may do with a cairn: the owner, or the best of their active shares. */
export interface CairnAccess {
  role: CairnRole;
  visibility: ShareVisibility;
  /** The share that grants access; null for the owner. */
  shareId: string | null;
}

export interface ShareOptions {
  role: ShareRole;
  visibility: ShareVisibility;
  expiresAt?: Date | null;
}

export interface ShareSummary {
  id: string;
  kind: 'email' | 'link';
  email: string | null;
  role: ShareRole;
  visibility: ShareVisibility;
  expiresAt: Date | null;
  createdAt: Date;
  /** Link shares: the people who opened the link. */
  redeemedBy: { id: string; email: string; name: string | null }[];
}

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Only the hash is stored; the token is shown to the owner once. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function cairnAccess(tx: Tx, cairnId: string): Promise<CairnAccess | undefined> {
  const [row] = await tx.execute<{
    role: CairnRole;
    visibility: ShareVisibility;
    share_id: string | null;
  }>(sql`select * from cairn_access(${cairnId})`);
  return row && { role: row.role, visibility: row.visibility, shareId: row.share_id };
}

// The sharing policy: who may see and do what with a cairn is decided by cairn_access() in the
// database (RLS uses the same function), and read here for the api.
export class ShareService {
  constructor(private db: Db) {}

  /** The caller's access to a cairn, or undefined if they have none (or it doesn't exist). */
  async access(userId: string, cairnId: string): Promise<CairnAccess | undefined> {
    return withUser(this.db, userId, (tx) => cairnAccess(tx, cairnId));
  }

  /** Shares the cairn with a Google account; it applies when that email signs in. */
  async shareWithEmail(
    userId: string,
    cairnId: string,
    email: string,
    opts: ShareOptions,
  ): Promise<Share> {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
      throw new InvalidInputError('not an email address');
    }
    checkOptions(opts);
    return withUser(this.db, userId, async (tx) => {
      await requireOwner(tx, cairnId);
      const [me] = await tx.select({ email: users.email }).from(users).where(eq(users.id, userId));
      if (me?.email.toLowerCase() === normalized) {
        throw new InvalidInputError('you already own this cairn');
      }
      try {
        const [share] = await tx
          .insert(shares)
          .values({ cairnId, granteeEmail: normalized, createdBy: userId, ...values(opts) })
          .returning();
        return share!;
      } catch (err) {
        // The live-email unique index; the transaction rolls back either way.
        if (pgCode(err) === '23505') {
          throw new ConflictError('this cairn is already shared with that email');
        }
        throw err;
      }
    });
  }

  /** Creates a link share; returns the token, which is not stored and can't be shown again. */
  async createLink(
    userId: string,
    cairnId: string,
    opts: ShareOptions,
  ): Promise<{ share: Share; token: string }> {
    checkOptions(opts);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const share = await withUser(this.db, userId, async (tx) => {
      await requireOwner(tx, cairnId);
      const [share] = await tx
        .insert(shares)
        .values({
          cairnId,
          linkTokenHash: hashShareToken(token),
          createdBy: userId,
          ...values(opts),
        })
        .returning();
      return share!;
    });
    return { share, token };
  }

  /** The cairn's shares that aren't revoked (expired ones included), oldest first. Owner only. */
  async list(userId: string, cairnId: string): Promise<ShareSummary[]> {
    return withUser(this.db, userId, async (tx) => {
      await requireOwner(tx, cairnId);
      const rows = await tx
        .select()
        .from(shares)
        .where(and(eq(shares.cairnId, cairnId), isNull(shares.revokedAt)))
        .orderBy(asc(shares.createdAt));
      const ids = rows.filter((s) => s.linkTokenHash).map((s) => s.id);
      const redeemed = ids.length
        ? await tx
            .select({
              shareId: shareRedemptions.shareId,
              id: users.id,
              email: users.email,
              name: users.name,
            })
            .from(shareRedemptions)
            .innerJoin(users, eq(users.id, shareRedemptions.userId))
            .where(inArray(shareRedemptions.shareId, ids))
            .orderBy(asc(shareRedemptions.createdAt))
        : [];
      return rows.map((s) => ({
        id: s.id,
        kind: s.granteeEmail ? 'email' : 'link',
        email: s.granteeEmail,
        role: s.role,
        visibility: s.visibility,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        redeemedBy: redeemed
          .filter((r) => r.shareId === s.id)
          .map(({ id, email, name }) => ({ id, email, name })),
      }));
    });
  }

  /** Revokes a share; access through it ends at once. Owner only. */
  async revoke(userId: string, cairnId: string, shareId: string): Promise<Share> {
    return withUser(this.db, userId, async (tx) => {
      await requireOwner(tx, cairnId);
      const [share] = await tx
        .update(shares)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(shares.id, shareId), eq(shares.cairnId, cairnId), isNull(shares.revokedAt)))
        .returning();
      if (!share) throw new NotFoundError('share');
      return share;
    });
  }

  /**
   * Gives the caller access through a link token. Returns the cairn id, or undefined when the
   * token is malformed, unknown, revoked or expired (callers can't tell which).
   */
  async redeem(userId: string, token: string): Promise<string | undefined> {
    if (!TOKEN_PATTERN.test(token)) return undefined;
    const rows = await withUser(this.db, userId, (tx) =>
      tx.execute<{ cairn_id: string }>(
        sql`select * from redeem_share_link(${hashShareToken(token)})`,
      ),
    );
    return rows[0]?.cairn_id;
  }
}

async function requireOwner(tx: Tx, cairnId: string): Promise<void> {
  const access = await cairnAccess(tx, cairnId);
  if (!access) throw new NotFoundError('cairn');
  if (access.role !== 'owner') throw new ForbiddenError('only the owner can manage sharing');
}

function checkOptions(opts: ShareOptions): void {
  if (opts.role === 'editor' && opts.visibility !== 'cited') {
    throw new InvalidInputError('editors see sources, so an editor share must be cited');
  }
  if (opts.expiresAt && opts.expiresAt.getTime() <= Date.now()) {
    throw new InvalidInputError('the expiry must be in the future');
  }
}

const values = (opts: ShareOptions) => ({
  role: opts.role,
  visibility: opts.visibility,
  expiresAt: opts.expiresAt ?? null,
});

function pgCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: string } }).cause;
  return cause?.code ?? (err as { code?: string }).code;
}
