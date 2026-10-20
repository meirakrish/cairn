import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

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

// Rows of these tables belong to a cairn: visible and writable exactly when the parent cairn is.
// The subquery on cairns is itself filtered by cairns' RLS, so widening cairn access (Phase 4 shares)
// widens these too.
const cairnVisible = (cairnId: unknown) =>
  sql`exists (select 1 from cairns c where c.id = ${cairnId})`;

/** Vector length of chunks.embedding. Changing it needs a migration and re-embedding every chunk. */
export const EMBEDDING_DIMENSIONS = 1024;

export const SOURCE_KINDS = ['text', 'markdown', 'pdf'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SOURCE_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cairnId: uuid('cairn_id')
      .notNull()
      .references(() => cairns.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: SOURCE_KINDS }).notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    size: integer('size').notNull(),
    status: text('status', { enum: SOURCE_STATUSES }).notNull().default('pending'),
    error: text('error'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sources_cairn_id_idx').on(t.cairnId, t.createdAt),
    // Target of chunks' composite FK, which keeps a chunk in its source's cairn.
    unique('sources_id_cairn_id_key').on(t.id, t.cairnId),
    check('sources_kind_check', sql`${t.kind} in (${inList(SOURCE_KINDS)})`),
    check('sources_status_check', sql`${t.status} in (${inList(SOURCE_STATUSES)})`),
    check('sources_size_check', sql`${t.size} >= 0`),
    pgPolicy('sources_cairn', {
      for: 'all',
      using: cairnVisible(t.cairnId),
      withCheck: cairnVisible(t.cairnId),
    }),
  ],
);

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cairnId: uuid('cairn_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    content: text('content').notNull(),
    // Where the chunk came from, e.g. { page: 3 } or { headings: ['Setup', 'Install'] }.
    location: jsonb('location').$type<ChunkLocation>().notNull().default({}),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    // 'simple' does no stemming or stop words, so it works for any language.
    tsv: tsvector('tsv')
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', content)`),
  },
  (t) => [
    foreignKey({
      name: 'chunks_source_fk',
      columns: [t.sourceId, t.cairnId],
      foreignColumns: [sources.id, sources.cairnId],
    }).onDelete('cascade'),
    unique('chunks_source_ordinal_key').on(t.sourceId, t.ordinal),
    index('chunks_cairn_id_idx').on(t.cairnId),
    index('chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('chunks_tsv_idx').using('gin', t.tsv),
    pgPolicy('chunks_cairn', {
      for: 'all',
      using: cairnVisible(t.cairnId),
      withCheck: cairnVisible(t.cairnId),
    }),
  ],
);

export const queryLog = pgTable(
  'query_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cairnId: uuid('cairn_id')
      .notNull()
      .references(() => cairns.id, { onDelete: 'cascade' }),
    // Who asked. Phase 4 adds share_id for link and API-key callers.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    // Chunks handed to the model, and the time until the answer finished.
    chunkCount: integer('chunk_count').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('query_log_cairn_id_idx').on(t.cairnId, t.createdAt),
    pgPolicy('query_log_cairn', {
      for: 'all',
      using: cairnVisible(t.cairnId),
      withCheck: cairnVisible(t.cairnId),
    }),
  ],
);

export interface ChunkLocation {
  /** 1-based PDF page. */
  page?: number;
  /** Markdown heading path, outermost first. */
  headings?: string[];
  /** Character offset of the chunk in the extracted text. */
  offset?: number;
}

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Cairn = typeof cairns.$inferSelect;
export type NewCairn = typeof cairns.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type QueryLogEntry = typeof queryLog.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
