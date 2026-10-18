import { sql } from 'drizzle-orm';
import { index, pgPolicy, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// The current user, set per transaction by withUser(). nullif() keeps an unset
// (empty) setting from failing the uuid cast; it just matches no rows.
const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  googleSub: text('google_sub').notNull().unique(),
  email: text('email').notNull(),
  name: text('name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cairns = pgTable(
  'cairns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    embedModel: text('embed_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cairns_owner_id_idx').on(t.ownerId),
    // Owner-only for now; Phase 4 widens reads to share grantees.
    pgPolicy('cairns_owner', {
      for: 'all',
      using: sql`${t.ownerId} = ${currentUserId}`,
      withCheck: sql`${t.ownerId} = ${currentUserId}`,
    }),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Cairn = typeof cairns.$inferSelect;
export type NewCairn = typeof cairns.$inferInsert;
