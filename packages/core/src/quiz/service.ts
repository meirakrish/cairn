import { randomInt } from 'node:crypto';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { LlmClient } from '@meirakrish/llm-kit';
import {
  chunks,
  quizAttempts,
  quizQuestions,
  sources,
  withUser,
  type ChunkLocation,
  type Db,
  type QuizQuestion,
  type QuizVerdict,
  type SourceKind,
  type Tx,
} from '../db';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../errors';
import { cairnAccess } from '../shares';
import { CHOICE_LIMITS, ChoiceDraft, questionMessages, similarQuestion } from './prompt';

export interface QuizOptions {
  signal?: AbortSignal;
}

/** A question as the caller sees it before answering: no right answer. */
export interface QuizQuestionView {
  /** The attempt: this question, put to this caller. answer() takes it. */
  id: string;
  question: string;
  choices: string[];
  /** Every question was already put to the caller, so this one is a repeat. */
  seenBefore: boolean;
}

export interface QuizPassageView {
  sourceId: string;
  filename: string;
  kind: SourceKind;
  url: string | null;
  location: ChunkLocation;
  text: string;
}

export interface QuizResult {
  verdict: QuizVerdict;
  /** The right option's index, and its text. */
  correctChoice: number;
  answer: string;
  /** Why the right option is right. */
  explanation: string;
  passage: QuizPassageView;
}

/** Passages shorter than this make thin questions; used only when nothing longer is left. */
export const MIN_QUIZ_CHARS = 200;
/** Questions written per passage; after that, the bank's questions are reused. */
export const QUESTIONS_PER_PASSAGE = 4;
/** Questions prepare() keeps ready that the caller hasn't seen. */
export const QUIZ_AHEAD = 2;

export const NOTHING_TO_QUIZ = 'This cairn has no ready files to quiz you on yet.';

/**
 * Quizzes a caller on one cairn's documents with multiple-choice questions. Questions are written
 * by the model from a passage and kept in the cairn's bank (quiz_questions) for everyone who can
 * see sources; next() serves one the caller hasn't seen, writes a new one when there is none, and
 * repeats the one seen longest ago only when no passage takes more questions. prepare() writes
 * ahead so next() rarely waits for the model. answer() checks the pick (no model). Runs as the user
 * (RLS); sealed callers get ForbiddenError, and only the caller who was asked can answer.
 */
export class QuizService {
  // The question being written for a caller and cairn: next() waits for it rather than writing a
  // second one alongside.
  private writing = new Map<string, Promise<unknown>>();
  // Passages (chunk ids) where the model wrote a copy of a question it was told was already
  // asked: they have nothing new to ask. Kept in memory; after a restart the first copy refills it.
  private full = new Set<string>();

  constructor(
    private db: Db,
    private llm: LlmClient,
  ) {}

  async next(userId: string, cairnId: string, opts: QuizOptions = {}): Promise<QuizQuestionView> {
    await withUser(this.db, userId, (tx) => this.checkAccess(tx, cairnId));
    await this.writing.get(writeKey(userId, cairnId))?.catch(() => {});

    let seenBefore = false;
    let question = await withUser(this.db, userId, (tx) => unseen(tx, userId, cairnId));
    question ??= await this.write(userId, cairnId, opts);
    if (!question) {
      question = await withUser(this.db, userId, (tx) => seenLongestAgo(tx, userId, cairnId));
      seenBefore = true;
    }
    if (!question) throw new InvalidInputError(NOTHING_TO_QUIZ);

    const [attempt] = await withUser(this.db, userId, (tx) =>
      tx
        .insert(quizAttempts)
        .values({ questionId: question.id, cairnId, userId })
        .returning({ id: quizAttempts.id }),
    );
    return { id: attempt!.id, question: question.question, choices: question.choices, seenBefore };
  }

  /**
   * Writes questions until the caller has `ahead` they haven't seen, or no passage takes more.
   * Meant to run in the background after next(); returns how many it wrote.
   */
  async prepare(userId: string, cairnId: string, ahead = QUIZ_AHEAD): Promise<number> {
    let written = 0;
    for (;;) {
      const waiting = await withUser(this.db, userId, async (tx) => {
        await this.checkAccess(tx, cairnId);
        return unseenCount(tx, userId, cairnId);
      });
      if (waiting >= ahead) return written;
      if (!(await this.write(userId, cairnId))) return written;
      written++;
    }
  }

  /** One new question for the bank, from the passage with the fewest; undefined when all are full. */
  private write(
    userId: string,
    cairnId: string,
    opts: QuizOptions = {},
  ): Promise<QuizQuestion | undefined> {
    const key = writeKey(userId, cairnId);
    const running = this.writeOne(userId, cairnId, opts).finally(() => {
      if (this.writing.get(key) === running) this.writing.delete(key);
    });
    this.writing.set(key, running);
    return running;
  }

  private async writeOne(
    userId: string,
    cairnId: string,
    opts: QuizOptions,
  ): Promise<QuizQuestion | undefined> {
    // A copy means that passage is out of questions; try the next one, a few times at most.
    for (let tries = 0; tries < 3; tries++) {
      const written = await this.writeFromNextPassage(userId, cairnId, opts);
      if (written !== 'copy') return written;
    }
    return undefined;
  }

  private async writeFromNextPassage(
    userId: string,
    cairnId: string,
    opts: QuizOptions,
  ): Promise<QuizQuestion | 'copy' | undefined> {
    const picked = await withUser(this.db, userId, async (tx) => {
      const passage = await passageToWriteFrom(tx, cairnId, [...this.full]);
      if (!passage) return undefined;
      const asked = await tx
        .select({ question: quizQuestions.question })
        .from(quizQuestions)
        .where(eq(quizQuestions.chunkId, passage.id));
      return { passage, asked: asked.map((a) => a.question) };
    });
    if (!picked) return undefined;
    const { passage, asked } = picked;

    // The model call runs outside a transaction: it takes seconds and needs no database.
    const draft = shuffled(
      await this.llm.structured(ChoiceDraft, questionMessages(passage, asked), {
        name: 'quiz_choice_question',
        limits: CHOICE_LIMITS,
        signal: opts.signal,
      }),
    );
    // A copy or rewording of a question already asked would only look new.
    if (asked.some((q) => similarQuestion(q, draft.question))) {
      this.full.add(passage.id);
      return 'copy';
    }

    const [row] = await withUser(this.db, userId, (tx) =>
      tx
        .insert(quizQuestions)
        .values({
          cairnId,
          chunkId: passage.id,
          question: draft.question,
          choices: draft.options,
          correctChoice: draft.correctOption,
          answer: draft.options[draft.correctOption]!,
          explanation: draft.explanation,
          createdBy: userId,
        })
        .returning(),
    );
    return row;
  }

  async answer(
    userId: string,
    cairnId: string,
    attemptId: string,
    choice: number,
  ): Promise<QuizResult> {
    const found = await withUser(this.db, userId, async (tx) => {
      await this.checkAccess(tx, cairnId);
      const [row] = await tx
        .select({
          answeredAt: quizAttempts.answeredAt,
          q: quizQuestions,
          passage: {
            sourceId: chunks.sourceId,
            filename: sources.filename,
            kind: sources.kind,
            url: sources.url,
            location: chunks.location,
            text: chunks.content,
          },
        })
        .from(quizAttempts)
        .innerJoin(quizQuestions, eq(quizQuestions.id, quizAttempts.questionId))
        .innerJoin(chunks, eq(chunks.id, quizQuestions.chunkId))
        .innerJoin(sources, eq(sources.id, chunks.sourceId))
        .where(and(eq(quizAttempts.id, attemptId), eq(quizAttempts.cairnId, cairnId)));
      return row;
    });
    if (!found) throw new NotFoundError('question');
    const { q, passage } = found;
    if (found.answeredAt) throw new ConflictError('this question was already answered');
    if (choice < 0 || choice >= q.choices.length) {
      throw new InvalidInputError('pick one of the options');
    }
    const verdict: QuizVerdict = choice === q.correctChoice ? 'correct' : 'wrong';

    // Only the first answer counts.
    const updated = await withUser(this.db, userId, (tx) =>
      tx
        .update(quizAttempts)
        .set({ choice, verdict, answeredAt: new Date() })
        .where(and(eq(quizAttempts.id, attemptId), isNull(quizAttempts.answeredAt)))
        .returning({ id: quizAttempts.id }),
    );
    if (updated.length === 0) throw new ConflictError('this question was already answered');

    return {
      verdict,
      correctChoice: q.correctChoice,
      answer: q.answer,
      explanation: q.explanation,
      passage,
    };
  }

  private async checkAccess(tx: Tx, cairnId: string): Promise<void> {
    const access = await cairnAccess(tx, cairnId);
    if (!access) throw new NotFoundError('cairn');
    if (access.visibility === 'sealed') {
      throw new ForbiddenError('the quiz needs access to the sources of this cairn');
    }
  }
}

const writeKey = (userId: string, cairnId: string) => `${userId}:${cairnId}`;

// Bank questions on ready files, with each file's position in a random order: ordering by it
// makes every file equally likely, however many questions it has.
const bankQuestions = (cairnId: string) => sql`
  select q.*, row_number() over (partition by c.source_id order by random()) as file_rank
  from ${quizQuestions} q
  join ${chunks} c on c.id = q.chunk_id
  join ${sources} s on s.id = c.source_id
  where q.cairn_id = ${cairnId} and s.status = 'ready'
`;

// The question's text with case and punctuation ignored: copies of one question match (the same
// rule in SQL, for counting the distinct questions of a passage).
const normalizedSql = (column: SQL) =>
  sql`trim(regexp_replace(lower(${column}), '[^[:alnum:]]+', ' ', 'g'))`;
const normalizeText = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// One question: the same text, or a rewording of it (the model rewrites "served as the foundation
// for" as "formed the foundation of", and two versions in a row look like a repeat).
const sameQuestion = (a: string, b: string) =>
  normalizeText(a) === normalizeText(b) || similarQuestion(a, b);

interface Asked {
  question: string;
  lastSeen: number;
}

/** The questions put to the caller in this cairn, each with when it was last shown. */
async function askedBefore(tx: Tx, userId: string, cairnId: string): Promise<Asked[]> {
  const rows = await tx.execute<{ question: string; last_seen: string }>(sql`
    select q.question, max(a.created_at) as last_seen
    from ${quizAttempts} a
    join ${quizQuestions} q on q.id = a.question_id
    where a.user_id = ${userId} and q.cairn_id = ${cairnId}
    group by q.question
  `);
  return rows.map((r) => ({ question: r.question, lastSeen: new Date(r.last_seen).getTime() }));
}

/** Bank questions, files equally likely, in random order within that. */
function bankRows(tx: Tx, cairnId: string) {
  return tx.execute<QuizRow>(sql`
    select * from (${bankQuestions(cairnId)}) b order by file_rank, random()
  `);
}

/**
 * Bank questions the caller has no version of yet (two questions can be copies or rewordings of
 * each other, even in the same bank), at random, files equally likely.
 */
async function freshQuestions(tx: Tx, userId: string, cairnId: string): Promise<QuizRow[]> {
  const asked = await askedBefore(tx, userId, cairnId);
  const fresh: QuizRow[] = [];
  for (const row of await bankRows(tx, cairnId)) {
    const known = (q: { question: string }) => sameQuestion(q.question, row.question);
    if (!asked.some(known) && !fresh.some(known)) fresh.push(row);
  }
  return fresh;
}

/** A bank question never put to the caller, at random, files equally likely. */
async function unseen(tx: Tx, userId: string, cairnId: string) {
  const [row] = await freshQuestions(tx, userId, cairnId);
  return row && fromRow(row);
}

async function unseenCount(tx: Tx, userId: string, cairnId: string) {
  return (await freshQuestions(tx, userId, cairnId)).length;
}

/** The bank question the caller saw longest ago; copies and rewordings of one question count as one. */
async function seenLongestAgo(tx: Tx, userId: string, cairnId: string) {
  const asked = await askedBefore(tx, userId, cairnId);
  let best: { row: QuizRow; lastSeen: number } | undefined;
  for (const row of await bankRows(tx, cairnId)) {
    const times = asked.filter((a) => sameQuestion(a.question, row.question));
    if (times.length === 0) continue;
    const lastSeen = Math.max(...times.map((a) => a.lastSeen));
    const older =
      !best ||
      lastSeen < best.lastSeen ||
      (lastSeen === best.lastSeen && new Date(row.created_at) < new Date(best.row.created_at));
    if (older) best = { row, lastSeen };
  }
  return best && fromRow(best.row);
}

/**
 * The passage to write the next question from: the fewest questions first (so
 * every passage gets asked about before any gets a second question), then longer passages, files
 * equally likely. Passages with QUESTIONS_PER_PASSAGE different questions are full, and so are
 * those in `skip`.
 */
async function passageToWriteFrom(tx: Tx, cairnId: string, skip: string[]) {
  const [row] = await tx.execute<{
    id: string;
    content: string;
    location: ChunkLocation;
    filename: string;
  }>(sql`
    with counts as (
      select chunk_id, count(distinct ${normalizedSql(sql`question`)})::int as n from ${quizQuestions}
      where cairn_id = ${cairnId}
      group by chunk_id
    ),
    ranked as (
      select c.id, c.source_id, c.content, c.location, s.filename,
        coalesce(counts.n, 0) as n,
        length(c.content) < ${MIN_QUIZ_CHARS} as short
      from ${chunks} c
      join ${sources} s on s.id = c.source_id
      left join counts on counts.chunk_id = c.id
      where c.cairn_id = ${cairnId} and s.status = 'ready'
        and coalesce(counts.n, 0) < ${QUESTIONS_PER_PASSAGE}
        ${
          skip.length
            ? sql`and c.id not in (${sql.join(
                skip.map((id) => sql`${id}`),
                sql`, `,
              )})`
            : sql``
        }
    ),
    per_file as (
      select *, row_number() over (partition by source_id, n, short order by random()) as r
      from ranked
    )
    select id, content, location, filename from per_file
    order by n, short, r, random()
    limit 1
  `);
  return row;
}

type QuizRow = {
  id: string;
  cairn_id: string;
  chunk_id: string;
  question: string;
  choices: string[];
  correct_choice: number;
  answer: string;
  explanation: string;
  created_by: string | null;
  created_at: string;
};

// Raw SQL rows come back in snake_case.
function fromRow(r: QuizRow): QuizQuestion {
  return {
    id: r.id,
    cairnId: r.cairn_id,
    chunkId: r.chunk_id,
    question: r.question,
    choices: r.choices,
    correctChoice: r.correct_choice,
    answer: r.answer,
    explanation: r.explanation,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at),
  };
}

/** The model tends to put the right answer in the same place; shuffle the options. */
function shuffled(draft: ChoiceDraft): ChoiceDraft {
  const order = draft.options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return {
    ...draft,
    options: order.map((i) => draft.options[i]!),
    correctOption: order.indexOf(draft.correctOption),
  };
}
