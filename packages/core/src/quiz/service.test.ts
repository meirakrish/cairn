import { fakeEmbedder, scriptedLlm } from '@meirakrish/llm-kit/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { chunks, EMBEDDING_DIMENSIONS, quizAttempts, quizQuestions, withUser } from '../db';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError } from '../errors';
import { ShareService } from '../shares';
import { SourceService } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import { CHOICE_PROMPT } from './prompt';
import { MIN_QUIZ_CHARS, NOTHING_TO_QUIZ, QUESTIONS_PER_PASSAGE, QuizService } from './service';

// Different questions need different words: similarQuestion() treats rewordings as copies.
const TOPICS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'foxtrot',
  'golf',
  'hotel',
  'india',
  'juliett',
];
const { admin, app } = createTestDbs();
const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS });
const cairns = new CairnService(app.db, embedder.model);
const sources = new SourceService(app.db);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

async function pgError(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => expect.fail('expected the query to fail'),
    (e: unknown) => e as Error & { cause?: Error },
  );
  return err.cause?.message ?? err.message;
}

const long = (text: string) => text.padEnd(MIN_QUIZ_CHARS + 10, ' and more of the same.');

async function addSource(userId: string, cairnId: string, filename: string, texts: string[]) {
  const source = await sources.create(userId, cairnId, {
    kind: 'pdf',
    filename,
    mime: 'application/pdf',
    size: 1,
  });
  const vectors = await embedder.embed(texts);
  await sources.complete(
    userId,
    source.id,
    texts.map((content, i) => ({ content, location: { page: i + 1 }, embedding: vectors[i]! })),
  );
  return source;
}

async function cairnWith(texts: string[]) {
  const user = await createUser(admin.db);
  const cairn = await cairns.create(user.id, { name: 'C' });
  const source = await addSource(user.id, cairn.id, 'trail.pdf', texts);
  return { user, cairn, source };
}

const choiceDraft = {
  question: 'What do cairns mark?',
  options: ['Trails', 'Rivers', 'Graves', 'Borders'],
  correctOption: 0,
  explanation: 'Cairns are piles of stones that mark trails.',
};
/** A model that writes a different question every time: What about alpha?, What about bravo?, … */
const numbered = () => {
  let n = 0;
  return scriptedLlm({
    structured: () => ({ ...choiceDraft, question: `What about ${TOPICS[n++]}?` }),
  });
};
const prompts = (llm: ReturnType<typeof scriptedLlm>) =>
  llm.calls.map((c) => String(c.messages[1]!.content));

describe('QuizService.next', () => {
  it('writes a question from a passage and keeps the right option to itself', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const llm = scriptedLlm({ structured: [choiceDraft] });
    const quiz = new QuizService(app.db, llm);

    const q = await quiz.next(user.id, cairn.id);

    expect(q).toMatchObject({ question: 'What do cairns mark?', seenBefore: false });
    expect(Object.keys(q).sort()).toEqual(['choices', 'id', 'question', 'seenBefore']);
    expect([...q.choices].sort()).toEqual([...choiceDraft.options].sort());

    expect(llm.calls[0]).toMatchObject({ kind: 'structured', name: 'quiz_choice_question' });
    expect(String(llm.calls[0]!.messages[0]!.content)).toBe(CHOICE_PROMPT);
    const prompt = prompts(llm)[0]!;
    expect(prompt).toContain('Cairns mark trails.');
    expect(prompt).toContain('source="trail.pdf, page 1"');

    // The stored index follows the shuffle.
    const [row] = await admin.db.select().from(quizQuestions);
    expect(row!.choices[row!.correctChoice]).toBe('Trails');
    expect(row).toMatchObject({ answer: 'Trails', createdBy: user.id });
    // The id is the attempt: this question, put to this user.
    expect(await admin.db.select().from(quizAttempts)).toMatchObject([
      { id: q.id, questionId: row!.id, userId: user.id, answeredAt: null },
    ]);
  });

  it('says there is nothing to quiz on without calling the model', async () => {
    const user = await createUser(admin.db);
    const empty = await cairns.create(user.id, { name: 'Empty' });
    const llm = scriptedLlm();

    const err = await new QuizService(app.db, llm).next(user.id, empty.id).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidInputError);
    expect(err.message).toBe(NOTHING_TO_QUIZ);
    expect(llm.calls).toEqual([]);
  });

  it('writes from the passages with the fewest questions first, and short ones last', async () => {
    const { user, cairn } = await cairnWith([long('First.'), long('Second.'), 'Short.']);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    for (let i = 0; i < 4; i++) await quiz.next(user.id, cairn.id);
    const used = prompts(llm).map((p) => p.match(/(First|Second|Short)\./)![1]);
    expect(used.slice(0, 2).sort()).toEqual(['First', 'Second']);
    expect(used[2]).toBe('Short');
    expect(['First', 'Second']).toContain(used[3]);
  });

  it('tells the model what was already asked about the passage', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    const first = await quiz.next(user.id, cairn.id);
    const second = await quiz.next(user.id, cairn.id);
    expect([first.question, second.question]).toEqual(['What about alpha?', 'What about bravo?']);
    expect(prompts(llm)[0]).not.toContain('already asked');
    expect(prompts(llm)[1]).toContain('- What about alpha?');
  });

  it('reuses the bank: a question written for one person is served to the next', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const guest = await createUser(admin.db);
    await new ShareService(app.db).shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'cited',
    });
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    const mine = await quiz.next(user.id, cairn.id);
    const theirs = await quiz.next(guest.id, cairn.id);
    expect(theirs.question).toBe(mine.question);
    expect(theirs.id).not.toBe(mine.id);
    expect(llm.calls).toHaveLength(1);
    // Once they've seen everything, a new one is written.
    await quiz.next(guest.id, cairn.id);
    expect(llm.calls).toHaveLength(2);
  });

  it('repeats only when every passage is full, the question seen longest ago first', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    const asked = [];
    for (let i = 0; i < QUESTIONS_PER_PASSAGE; i++) {
      asked.push((await quiz.next(user.id, cairn.id)).question);
    }
    expect(new Set(asked).size).toBe(QUESTIONS_PER_PASSAGE);

    const again = await quiz.next(user.id, cairn.id);
    expect(again).toMatchObject({ question: asked[0], seenBefore: true });
    expect(llm.calls).toHaveLength(QUESTIONS_PER_PASSAGE);
    expect((await quiz.next(user.id, cairn.id)).question).toBe(asked[1]);
  });

  it('does not store a copy, and stops writing from a passage that gave one', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const llm = scriptedLlm({ structured: () => choiceDraft });
    const quiz = new QuizService(app.db, llm);

    await quiz.next(user.id, cairn.id);
    const copy = await quiz.next(user.id, cairn.id);
    expect(copy.seenBefore).toBe(true);
    expect(await admin.db.select().from(quizQuestions)).toHaveLength(1);
    expect(llm.calls).toHaveLength(2);

    // The passage is full now: repeats come without asking the model again.
    await quiz.next(user.id, cairn.id);
    expect(llm.calls).toHaveLength(2);
  });

  it('moves on to another passage when one gives a copy', async () => {
    const { user, cairn } = await cairnWith([long('First.'), long('Second.')]);
    const llm = scriptedLlm({
      structured: (_name, messages) => {
        const prompt = String(messages[1]!.content);
        // The first passage only ever gets one question; the second gets new ones.
        if (prompt.includes('First.')) return choiceDraft;
        return { ...choiceDraft, question: `About the second, ${prompt.length}?` };
      },
    });
    const quiz = new QuizService(app.db, llm);

    const asked = [];
    for (let i = 0; i < 4; i++) asked.push(await quiz.next(user.id, cairn.id));
    expect(asked.every((q) => !q.seenBefore)).toBe(true);
    expect(new Set(asked.map((q) => q.question)).size).toBe(4);
  });

  it('repeats copies of one question as one, the text seen longest ago first', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, scriptedLlm({ structured: [] }));
    const [chunk] = await admin.db.select().from(chunks);
    const bank = (question: string) => ({
      cairnId: cairn.id,
      chunkId: chunk!.id,
      question,
      choices: ['x', 'y'],
      correctChoice: 0,
      answer: 'x',
      explanation: 'e',
    });
    // A and a copy of A, then B, C, D: full, so nothing new gets written.
    await admin.db
      .insert(quizQuestions)
      .values([bank('A?'), bank('a'), bank('B?'), bank('C?'), bank('D?')]);

    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await quiz.next(user.id, cairn.id)).question);
    expect(seen.map((q) => q.toUpperCase()[0]).sort()).toEqual(['A', 'B', 'C', 'D']);

    const repeats = [];
    for (let i = 0; i < 4; i++) {
      const q = await quiz.next(user.id, cairn.id);
      expect(q.seenBefore).toBe(true);
      repeats.push(q.question.toUpperCase()[0]);
    }
    expect(repeats).toEqual(seen.map((q) => q.toUpperCase()[0]));
  });

  it('treats a bank question with the text of one already asked as seen', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, numbered());
    const first = await quiz.next(user.id, cairn.id);
    // Another copy, as two quizzes writing at once (or the first version of the quiz) could leave.
    const [stored] = await admin.db.select().from(quizQuestions);
    await admin.db
      .insert(quizQuestions)
      .values({ ...stored!, id: undefined, question: 'WHAT ABOUT ALPHA' });

    const next = await quiz.next(user.id, cairn.id);
    expect(first.question).toBe('What about alpha?');
    expect(next).toMatchObject({ question: 'What about bravo?', seenBefore: false });
  });

  it('prepare() writes ahead, so next() needs no model call', async () => {
    const { user, cairn } = await cairnWith([long('First.'), long('Second.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    expect(await quiz.prepare(user.id, cairn.id, 2)).toBe(2);
    expect(await quiz.prepare(user.id, cairn.id, 2)).toBe(0);
    await quiz.next(user.id, cairn.id);
    await quiz.next(user.id, cairn.id);
    expect(llm.calls).toHaveLength(2);
  });

  it('next() waits for a question being written instead of writing another', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    const preparing = quiz.prepare(user.id, cairn.id, 1);
    const q = await quiz.next(user.id, cairn.id);
    await preparing;
    expect(q.question).toBe('What about alpha?');
    expect(llm.calls).toHaveLength(1);
  });

  it('refuses strangers and sealed grantees, and serves cited grantees', async () => {
    const { user, cairn } = await cairnWith([long('Private notes.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);
    const shares = new ShareService(app.db);

    const stranger = await createUser(admin.db);
    await expect(quiz.next(stranger.id, cairn.id)).rejects.toBeInstanceOf(NotFoundError);

    const sealed = await createUser(admin.db);
    await shares.shareWithEmail(user.id, cairn.id, sealed.email, {
      role: 'viewer',
      visibility: 'sealed',
    });
    await expect(quiz.next(sealed.id, cairn.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(quiz.prepare(sealed.id, cairn.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(llm.calls).toEqual([]);

    const cited = await createUser(admin.db);
    await shares.shareWithEmail(user.id, cairn.id, cited.email, {
      role: 'viewer',
      visibility: 'cited',
    });
    await expect(quiz.next(cited.id, cairn.id)).resolves.toMatchObject({ seenBefore: false });
  });
});

describe('QuizService.answer', () => {
  it('checks the pick without the model, once', async () => {
    const { user, cairn, source } = await cairnWith([long('Cairns mark trails.')]);
    const llm = numbered();
    const quiz = new QuizService(app.db, llm);

    const q = await quiz.next(user.id, cairn.id);
    const right = q.choices.indexOf('Trails');
    const result = await quiz.answer(user.id, cairn.id, q.id, right);
    expect(result).toMatchObject({
      verdict: 'correct',
      correctChoice: right,
      answer: 'Trails',
      explanation: choiceDraft.explanation,
      passage: { sourceId: source.id, filename: 'trail.pdf', location: { page: 1 } },
    });
    expect(llm.calls).toHaveLength(1);

    await expect(quiz.answer(user.id, cairn.id, q.id, right)).rejects.toBeInstanceOf(ConflictError);

    const q2 = await quiz.next(user.id, cairn.id);
    const wrong = (q2.choices.indexOf('Trails') + 1) % 4;
    await expect(quiz.answer(user.id, cairn.id, q2.id, wrong)).resolves.toMatchObject({
      verdict: 'wrong',
    });
    const [row] = await admin.db.select().from(quizAttempts).where(eq(quizAttempts.id, q2.id));
    expect(row).toMatchObject({ choice: wrong, verdict: 'wrong' });
  });

  it('rejects an option that does not exist', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, scriptedLlm({ structured: [choiceDraft] }));
    const q = await quiz.next(user.id, cairn.id);

    for (const bad of [4, -1]) {
      await expect(quiz.answer(user.id, cairn.id, q.id, bad)).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
  });

  it("hides other people's questions", async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, scriptedLlm({ structured: [choiceDraft] }));
    const q = await quiz.next(user.id, cairn.id);

    const guest = await createUser(admin.db);
    await new ShareService(app.db).shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'cited',
    });
    await expect(quiz.answer(guest.id, cairn.id, q.id, 0)).rejects.toBeInstanceOf(NotFoundError);

    const other = await cairns.create(user.id, { name: 'Other' });
    await expect(quiz.answer(user.id, other.id, q.id, 0)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('drops questions when their file is deleted', async () => {
    const { user, cairn, source } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, scriptedLlm({ structured: [choiceDraft] }));
    const q = await quiz.next(user.id, cairn.id);

    await sources.delete(user.id, source.id);
    expect(await admin.db.select().from(quizQuestions)).toEqual([]);
    await expect(quiz.answer(user.id, cairn.id, q.id, 0)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('quiz RLS', () => {
  it('shares the bank with callers who can see sources, and keeps attempts to their owner', async () => {
    const { user, cairn } = await cairnWith([long('Cairns mark trails.')]);
    const quiz = new QuizService(app.db, scriptedLlm({ structured: [choiceDraft] }));
    const ownerAttempt = await quiz.next(user.id, cairn.id);
    const [chunk] = await admin.db.select().from(chunks);
    const [question] = await admin.db.select().from(quizQuestions);

    const guest = await createUser(admin.db);
    const shares = new ShareService(app.db);
    const share = await shares.shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'sealed',
    });
    const row = {
      cairnId: cairn.id,
      chunkId: chunk!.id,
      question: 'q',
      choices: ['a', 'b'],
      correctChoice: 0,
      answer: 'a',
      explanation: 'e',
    };
    const as = <T>(fn: (tx: Parameters<Parameters<typeof withUser>[2]>[0]) => Promise<T>) =>
      withUser(app.db, guest.id, fn);

    // Sealed: no bank, no attempts.
    expect(await as((tx) => tx.select().from(quizQuestions))).toEqual([]);
    expect(
      await pgError(as((tx) => tx.insert(quizQuestions).values({ ...row, createdBy: guest.id }))),
    ).toMatch(/row-level security/);
    expect(
      await pgError(
        as((tx) =>
          tx
            .insert(quizAttempts)
            .values({ questionId: question!.id, cairnId: cairn.id, userId: guest.id }),
        ),
      ),
    ).toMatch(/row-level security/);

    // Cited: reads and adds to the bank (in their own name), sees only their own attempts.
    await shares.revoke(user.id, cairn.id, share.id);
    await shares.shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'cited',
    });
    expect(await as((tx) => tx.select().from(quizQuestions))).toHaveLength(1);
    await as((tx) => tx.insert(quizQuestions).values({ ...row, createdBy: guest.id }));
    expect(
      await pgError(as((tx) => tx.insert(quizQuestions).values({ ...row, createdBy: user.id }))),
    ).toMatch(/row-level security/);
    expect(await as((tx) => tx.select().from(quizAttempts))).toEqual([]);
    expect(
      await pgError(
        as((tx) =>
          tx
            .insert(quizAttempts)
            .values({ questionId: question!.id, cairnId: cairn.id, userId: user.id }),
        ),
      ),
    ).toMatch(/row-level security/);
    // The bank isn't editable, not even by the owner.
    const edited = await withUser(app.db, user.id, (tx) =>
      tx.update(quizQuestions).set({ answer: 'x' }).returning(),
    );
    expect(edited).toEqual([]);
    expect(ownerAttempt.id).toBeDefined();
  });
});
