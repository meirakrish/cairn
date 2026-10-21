import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
    // Owners do everything; an active share lets its grantee read the cairn.
    pgPolicy('cairns_read', {
      for: 'select',
      using: sql`${t.ownerId} = ${currentUserId} or exists (select 1 from cairn_access(${t.id}))`,
    }),
    pgPolicy('cairns_insert', { for: 'insert', withCheck: sql`${t.ownerId} = ${currentUserId}` }),
    pgPolicy('cairns_update', {
      for: 'update',
      using: sql`${t.ownerId} = ${currentUserId}`,
      withCheck: sql`${t.ownerId} = ${currentUserId}`,
    }),
    pgPolicy('cairns_delete', { for: 'delete', using: sql`${t.ownerId} = ${currentUserId}` }),
  ],
);

// cairn_access(cairn_id) (migration 0003) returns the caller's access to a cairn as one row
// (role, visibility, share_id), or no row. It is security definer, so policies on cairns can
// look at shares, and policies on shares at cairns, without recursing through each other's RLS.

// Rows of these tables belong to a cairn and are readable exactly when the cairn is: the subquery
// on cairns is itself filtered by cairns' RLS. Sealed callers can read them too (retrieval needs
// chunks); the services keep sources and passages from reaching them.
const cairnVisible = (cairnId: unknown) =>
  sql`exists (select 1 from cairns c where c.id = ${cairnId})`;
// Adding sources and writing chunks (the worker runs as the uploader): owners and editors.
const cairnEditable = (cairnId: unknown) =>
  sql`exists (select 1 from cairn_access(${cairnId}) a where a.role in ('owner', 'editor'))`;
// The quiz: callers who can see sources (owners and cited grantees).
const cairnCited = (cairnId: unknown) =>
  sql`exists (select 1 from cairn_access(${cairnId}) a where a.visibility = 'cited')`;
const cairnOwned = (cairnId: unknown) =>
  sql`exists (select 1 from cairns c where c.id = ${cairnId} and c.owner_id = ${currentUserId})`;

const readEditDelete = (name: string, cairnId: unknown, canDelete: (id: unknown) => SQL) => [
  pgPolicy(`${name}_read`, { for: 'select', using: cairnVisible(cairnId) }),
  pgPolicy(`${name}_insert`, { for: 'insert', withCheck: cairnEditable(cairnId) }),
  pgPolicy(`${name}_update`, {
    for: 'update',
    using: cairnEditable(cairnId),
    withCheck: cairnEditable(cairnId),
  }),
  pgPolicy(`${name}_delete`, { for: 'delete', using: canDelete(cairnId) }),
];

/** Vector length of chunks.embedding. Changing it needs a migration and re-embedding every chunk. */
export const EMBEDDING_DIMENSIONS = 1024;

export const SOURCE_KINDS = ['text', 'markdown', 'pdf', 'csv', 'json', 'image', 'web'] as const;
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
    /** Where a web source was fetched from (null for uploads). */
    url: text('url'),
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
    // A page is added to a cairn once; adding it again means refreshing it (uploads have no url).
    uniqueIndex('sources_cairn_url_key').on(t.cairnId, t.url),
    check('sources_kind_check', sql`${t.kind} in (${inList(SOURCE_KINDS)})`),
    check('sources_status_check', sql`${t.status} in (${inList(SOURCE_STATUSES)})`),
    check('sources_size_check', sql`${t.size} >= 0`),
    // Only the owner deletes sources; editors add them.
    ...readEditDelete('sources', t.cairnId, cairnOwned),
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
    // Reprocessing a source replaces its chunks, so editors delete chunks too.
    ...readEditDelete('chunks', t.cairnId, cairnEditable),
  ],
);

export const SHARE_ROLES = ['viewer', 'editor'] as const;
export type ShareRole = (typeof SHARE_ROLES)[number];
/** Access to a cairn: the owner, or a share's role. */
export type CairnRole = 'owner' | ShareRole;

export const SHARE_VISIBILITIES = ['cited', 'sealed'] as const;
export type ShareVisibility = (typeof SHARE_VISIBILITIES)[number];

// A grant to one Google account (grantee_email) or to whoever redeems a link (link_token_hash).
// A share is active until revoked_at or expires_at; nothing is deleted, so the log keeps its share.
export const shares = pgTable(
  'shares',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cairnId: uuid('cairn_id')
      .notNull()
      .references(() => cairns.id, { onDelete: 'cascade' }),
    // Lowercased; matched against the signed-in user's verified Google email.
    granteeEmail: text('grantee_email'),
    // sha256 hex of the link token; the token itself is shown once and never stored.
    linkTokenHash: text('link_token_hash').unique(),
    role: text('role', { enum: SHARE_ROLES }).notNull(),
    visibility: text('visibility', { enum: SHARE_VISIBILITIES }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('shares_cairn_id_idx').on(t.cairnId, t.createdAt),
    // One live email share per person and cairn; changing it means revoking and sharing again.
    uniqueIndex('shares_cairn_email_key')
      .on(t.cairnId, t.granteeEmail)
      .where(sql`${t.granteeEmail} is not null and ${t.revokedAt} is null`),
    check('shares_grantee_check', sql`(${t.granteeEmail} is null) <> (${t.linkTokenHash} is null)`),
    check('shares_email_check', sql`${t.granteeEmail} = lower(${t.granteeEmail})`),
    check('shares_role_check', sql`${t.role} in (${inList(SHARE_ROLES)})`),
    check('shares_visibility_check', sql`${t.visibility} in (${inList(SHARE_VISIBILITIES)})`),
    // Editors add and see sources, so a sealed editor makes no sense.
    check('shares_editor_cited_check', sql`${t.role} <> 'editor' or ${t.visibility} = 'cited'`),
    pgPolicy('shares_owner', {
      for: 'all',
      using: cairnOwned(t.cairnId),
      withCheck: cairnOwned(t.cairnId),
    }),
  ],
);

// Users who opened a link share. Inserted only by redeem_share_link() (migration 0003), which
// checks the token; there is no insert policy.
export const shareRedemptions = pgTable(
  'share_redemptions',
  {
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.shareId, t.userId] }),
    index('share_redemptions_user_id_idx').on(t.userId),
    pgPolicy('share_redemptions_read', {
      for: 'select',
      using: sql`${t.userId} = ${currentUserId} or exists (select 1 from shares s where s.id = ${t.shareId})`,
    }),
    // A user can leave; the owner (who sees the share) can remove someone.
    pgPolicy('share_redemptions_delete', {
      for: 'delete',
      using: sql`${t.userId} = ${currentUserId} or exists (select 1 from shares s where s.id = ${t.shareId})`,
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
    // Who asked, and through which share (null for the owner).
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    shareId: uuid('share_id').references(() => shares.id, { onDelete: 'set null' }),
    question: text('question').notNull(),
    // Chunks handed to the model, and the time until the answer finished.
    chunkCount: integer('chunk_count').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('query_log_cairn_id_idx').on(t.cairnId, t.createdAt),
    // Anyone with access logs their own questions; only the owner reads everyone's.
    pgPolicy('query_log_read', {
      for: 'select',
      using: sql`${t.userId} = ${currentUserId} or ${cairnOwned(t.cairnId)}`,
    }),
    pgPolicy('query_log_insert', {
      for: 'insert',
      withCheck: sql`${t.userId} = ${currentUserId} and ${cairnVisible(t.cairnId)}`,
    }),
  ],
);

export const QUIZ_VERDICTS = ['correct', 'wrong'] as const;
export type QuizVerdict = (typeof QUIZ_VERDICTS)[number];

// A cairn's question bank: multiple-choice questions the model wrote from one chunk each, kept and reused for
// everyone who can see the cairn's sources (owners and cited grantees). Who was asked what, and
// how they answered, is in quiz_attempts; the expected answer leaves the server only after an answer.
export const quizQuestions = pgTable(
  'quiz_questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cairnId: uuid('cairn_id')
      .notNull()
      .references(() => cairns.id, { onDelete: 'cascade' }),
    // The question goes when its passage does (source deleted or reprocessed).
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    // The options as shown, the index of the right one, its text, and why it is right.
    choices: jsonb('choices').$type<string[]>().notNull(),
    correctChoice: integer('correct_choice').notNull(),
    answer: text('answer').notNull(),
    explanation: text('explanation').notNull(),
    // Whose quiz asked for it; the question stays when they go.
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('quiz_questions_cairn_idx').on(t.cairnId),
    index('quiz_questions_chunk_id_idx').on(t.chunkId),
    check(
      'quiz_questions_choice_check',
      sql`${t.correctChoice} >= 0 and ${t.correctChoice} < jsonb_array_length(${t.choices})`,
    ),
    // Read and add on a cairn whose sources you can see; nobody edits the bank.
    pgPolicy('quiz_questions_read', { for: 'select', using: cairnCited(t.cairnId) }),
    pgPolicy('quiz_questions_insert', {
      for: 'insert',
      withCheck: sql`${t.createdBy} = ${currentUserId} and ${cairnCited(t.cairnId)}`,
    }),
  ],
);

// One question put to one user: created when it is served, completed when they answer.
export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => quizQuestions.id, { onDelete: 'cascade' }),
    cairnId: uuid('cairn_id')
      .notNull()
      .references(() => cairns.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // The option the caller picked, and whether it was right.
    choice: integer('choice'),
    verdict: text('verdict', { enum: QUIZ_VERDICTS }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('quiz_attempts_user_cairn_idx').on(t.userId, t.cairnId, t.createdAt),
    index('quiz_attempts_question_id_idx').on(t.questionId),
    check(
      'quiz_attempts_verdict_check',
      sql`${t.verdict} is null or ${t.verdict} in (${inList(QUIZ_VERDICTS)})`,
    ),
    check(
      'quiz_attempts_answered_check',
      sql`(${t.answeredAt} is null) = (${t.verdict} is null) and (${t.verdict} is null) = (${t.choice} is null)`,
    ),
    // Your own attempts, on a cairn whose sources you can see.
    pgPolicy('quiz_attempts_own', {
      for: 'all',
      using: sql`${t.userId} = ${currentUserId} and ${cairnCited(t.cairnId)}`,
      withCheck: sql`${t.userId} = ${currentUserId} and ${cairnCited(t.cairnId)}`,
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
  /** CSV: first and last spreadsheet row (the header is row 1). */
  rows?: [number, number];
  /** JSON Lines: first and last line. */
  lines?: [number, number];
  /** JSON: the record's path, or the first and last ("$.orders[3] … $.orders[9]"). */
  path?: string;
}

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Cairn = typeof cairns.$inferSelect;
export type NewCairn = typeof cairns.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type Share = typeof shares.$inferSelect;
export type NewShare = typeof shares.$inferInsert;
export type QueryLogEntry = typeof queryLog.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;
export type QuizQuestion = typeof quizQuestions.$inferSelect;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
