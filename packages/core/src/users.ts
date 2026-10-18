import { users, type Db, type User } from './db';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

// Google's `sub` is the stable identity; email, name and avatar are refreshed on every login.
export async function upsertGoogleUser(db: Db, profile: GoogleProfile): Promise<User> {
  const { sub, ...rest } = profile;
  const [user] = await db
    .insert(users)
    .values({ googleSub: sub, ...rest })
    .onConflictDoUpdate({ target: users.googleSub, set: rest })
    .returning();
  return user!;
}

export async function getUser(db: Db, id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, id) });
}
