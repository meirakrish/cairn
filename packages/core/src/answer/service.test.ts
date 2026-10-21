import type { AnswerEvent } from '@cairn/shared';
import { fakeEmbedder, scriptedLlm } from '@meirakrish/llm-kit/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CairnService } from '../cairns';
import { EMBEDDING_DIMENSIONS, queryLog } from '../db';
import { ForbiddenError, NotFoundError } from '../errors';
import { RetrievalService } from '../retrieval';
import { ShareService } from '../shares';
import { SourceService } from '../sources';
import { createTestDbs, createUser, resetDb } from '../testing';
import { AnswerService, NOTHING_FOUND } from './service';

const { admin, app } = createTestDbs();
const embedder = fakeEmbedder({ dimensions: EMBEDDING_DIMENSIONS });
const cairns = new CairnService(app.db, embedder.model);
const sources = new SourceService(app.db);
const retrieval = new RetrievalService(app.db, embedder);

beforeEach(() => resetDb(admin.db));
afterAll(async () => {
  await admin.close();
  await app.close();
});

async function cairnWith(texts: string[]) {
  const user = await createUser(admin.db);
  const cairn = await cairns.create(user.id, { name: 'C' });
  const source = await sources.create(user.id, cairn.id, {
    kind: 'pdf',
    filename: 'trail.pdf',
    mime: 'application/pdf',
    size: 1,
  });
  const vectors = await embedder.embed(texts);
  await sources.complete(
    user.id,
    source.id,
    texts.map((content, i) => ({ content, location: { page: i + 1 }, embedding: vectors[i]! })),
  );
  return { user, cairn, source };
}

async function collect(events: AsyncIterable<AnswerEvent>) {
  const out: AnswerEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('AnswerService.answer', () => {
  it('streams passages, the answer and its citations, and logs the question', async () => {
    const { user, cairn, source } = await cairnWith(['Cairns mark trails.', 'Hikers add stones.']);
    const llm = scriptedLlm({ stream: [['Cairns mark ', 'trails [1]', ', and grow [2].']] });
    const answers = new AnswerService(app.db, retrieval, llm);

    const events = await collect(answers.answer(user.id, cairn.id, 'What do cairns do?'));

    const [passages, ...rest] = events;
    expect(passages).toMatchObject({ type: 'passages' });
    const list = (passages as Extract<AnswerEvent, { type: 'passages' }>).passages;
    expect(list.map((p) => p.n)).toEqual([1, 2]);
    expect(list[0]).toMatchObject({ sourceId: source.id, filename: 'trail.pdf', kind: 'pdf' });
    expect(rest.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual(
      ['Cairns mark ', 'trails [1]', ', and grow [2].'],
    );
    expect(rest.at(-1)).toMatchObject({ type: 'done', cited: [1, 2] });

    // The model saw both passages and the question.
    const prompt = String(llm.calls[0]!.messages[1]!.content);
    expect(prompt).toContain('Cairns mark trails.');
    expect(prompt).toContain('Question: What do cairns do?');

    expect(await admin.db.select().from(queryLog)).toMatchObject([
      { cairnId: cairn.id, userId: user.id, question: 'What do cairns do?', chunkCount: 2 },
    ]);
  });

  it('answers without the model when the cairn has nothing indexed', async () => {
    const user = await createUser(admin.db);
    const empty = await cairns.create(user.id, { name: 'Empty' });
    const llm = scriptedLlm();
    const answers = new AnswerService(app.db, retrieval, llm);

    const events = await collect(answers.answer(user.id, empty.id, 'Anything?'));
    expect(events.map((e) => e.type)).toEqual(['passages', 'delta', 'done']);
    expect(events[1]).toEqual({ type: 'delta', text: NOTHING_FOUND });
    expect(llm.calls).toEqual([]);
  });

  it("refuses someone else's cairn before searching or calling the model", async () => {
    const { cairn } = await cairnWith(['Private notes.']);
    const stranger = await createUser(admin.db);
    const llm = scriptedLlm();
    const answers = new AnswerService(app.db, retrieval, llm);

    await expect(collect(answers.answer(stranger.id, cairn.id, 'notes?'))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(llm.calls).toEqual([]);
    expect(await admin.db.select().from(queryLog)).toEqual([]);
  });

  it('lets a model failure through and logs nothing', async () => {
    const { user, cairn } = await cairnWith(['Text.']);
    const answers = new AnswerService(
      app.db,
      retrieval,
      scriptedLlm({ stream: [new Error('model down')] }),
    );

    await expect(collect(answers.answer(user.id, cairn.id, 'q'))).rejects.toThrow('model down');
    expect(await admin.db.select().from(queryLog)).toEqual([]);
  });

  it('answers a cited grantee and logs the share the question came through', async () => {
    const { user, cairn } = await cairnWith(['Cairns mark trails.']);
    const guest = await createUser(admin.db);
    const share = await new ShareService(app.db).shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'cited',
    });
    const answers = new AnswerService(
      app.db,
      retrieval,
      scriptedLlm({ stream: [['Trails [1].']] }),
    );

    const events = await collect(answers.answer(guest.id, cairn.id, 'What do cairns do?'));
    expect(events.at(-1)).toMatchObject({ type: 'done', cited: [1] });
    expect(await admin.db.select().from(queryLog)).toMatchObject([
      { userId: guest.id, shareId: share.id },
    ]);
  });

  it('refuses sealed grantees until sealed answers exist', async () => {
    const { user, cairn } = await cairnWith(['Cairns mark trails.']);
    const guest = await createUser(admin.db);
    await new ShareService(app.db).shareWithEmail(user.id, cairn.id, guest.email, {
      role: 'viewer',
      visibility: 'sealed',
    });
    const llm = scriptedLlm();
    const answers = new AnswerService(app.db, retrieval, llm);

    await expect(collect(answers.answer(guest.id, cairn.id, 'q'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(llm.calls).toEqual([]);
  });
});
