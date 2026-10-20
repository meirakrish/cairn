import { desc, eq } from 'drizzle-orm';
import { cairns, withUser, type Cairn, type Db } from './db';

export interface CreateCairnInput {
  name: string;
  description?: string | null;
}

// All access goes through withUser, so RLS limits every query to the caller's own cairns.
export class CairnService {
  constructor(
    private db: Db,
    private embedModel: string,
  ) {}

  async create(userId: string, input: CreateCairnInput): Promise<Cairn> {
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
      return cairn!;
    });
  }

  async get(userId: string, cairnId: string): Promise<Cairn | undefined> {
    return withUser(this.db, userId, async (tx) => {
      const [cairn] = await tx.select().from(cairns).where(eq(cairns.id, cairnId));
      return cairn;
    });
  }

  async list(userId: string): Promise<Cairn[]> {
    return withUser(this.db, userId, (tx) =>
      tx.select().from(cairns).orderBy(desc(cairns.createdAt)),
    );
  }
}
