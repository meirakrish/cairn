import { desc, eq, getTableColumns, sql } from 'drizzle-orm';
import { cairns, withUser, type Cairn, type CairnRole, type Db, type ShareVisibility } from './db';
import type { CairnAccess } from './shares';

export interface CreateCairnInput {
  name: string;
  description?: string | null;
}

/** A cairn with the caller's access to it (owner, or the share they see it through). */
export interface CairnWithAccess extends Cairn {
  access: CairnAccess;
}

// cairn_access() for each visible row; RLS already guarantees there is one.
const withAccess = {
  ...getTableColumns(cairns),
  role: sql<CairnRole>`a.role`,
  visibility: sql<ShareVisibility>`a.visibility`,
  shareId: sql<string | null>`a.share_id`,
};
const accessJoin = sql`lateral cairn_access(${cairns.id}) a`;

type Row = Cairn & { role: CairnRole; visibility: ShareVisibility; shareId: string | null };

function toCairnWithAccess({ role, visibility, shareId, ...cairn }: Row): CairnWithAccess {
  return { ...cairn, access: { role, visibility, shareId } };
}

// All access goes through withUser, so RLS limits every query to cairns the caller owns or is
// shared on.
export class CairnService {
  constructor(
    private db: Db,
    private embedModel: string,
  ) {}

  async create(userId: string, input: CreateCairnInput): Promise<CairnWithAccess> {
    return withUser(this.db, userId, async (tx) => {
      const [cairn] = await tx
        .insert(cairns)
        .values({
          ownerId: userId,
          name: input.name,
          description: input.description ?? null,
          embedModel: this.embedModel,
        })
        .returning();
      return { ...cairn!, access: { role: 'owner', visibility: 'cited', shareId: null } };
    });
  }

  async get(userId: string, cairnId: string): Promise<CairnWithAccess | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [row] = await tx
        .select(withAccess)
        .from(cairns)
        .innerJoin(accessJoin, sql`true`)
        .where(eq(cairns.id, cairnId));
      return row && toCairnWithAccess(row);
    });
  }

  /** Renames a cairn; undefined unless the caller owns it (RLS lets only owners update). */
  async update(
    userId: string,
    cairnId: string,
    input: CreateCairnInput,
  ): Promise<CairnWithAccess | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [cairn] = await tx
        .update(cairns)
        .set({ name: input.name, description: input.description ?? null })
        .where(eq(cairns.id, cairnId))
        .returning();
      return cairn && { ...cairn, access: { role: 'owner', visibility: 'cited', shareId: null } };
    });
  }

  /** Owned and shared cairns, newest first. */
  async list(userId: string): Promise<CairnWithAccess[]> {
    return withUser(this.db, userId, async (tx) => {
      const rows = await tx
        .select(withAccess)
        .from(cairns)
        .innerJoin(accessJoin, sql`true`)
        .orderBy(desc(cairns.createdAt));
      return rows.map(toCairnWithAccess);
    });
  }
}
