import {
  AnswerEvent,
  CairnResponse,
  CreateShareResponse,
  DuplicateUrlResponse,
  ListCairnsResponse,
  ListSharesResponse,
  MeResponse,
  QuizQuestionResponse,
  QuizResultResponse,
  RedeemShareLinkResponse,
  SealedAnswerEvent,
  SourceResponse,
  type Cairn,
  type CreateCairnRequest,
  type UpdateCairnRequest,
  type CreateShareRequest,
  type QuizQuestion,
  type QuizResult,
  type Share,
  type Source,
  type User,
} from '@cairn/shared';
import { sseData } from './answer';

type Fetch = typeof globalThis.fetch;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(
  fetch: Fetch,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? `${method} ${path}: ${res.status}`);
  }
  return res.status === 204 ? undefined : res.json();
}

export async function getMe(fetch: Fetch): Promise<User | null> {
  try {
    return MeResponse.parse(await request(fetch, 'GET', '/api/auth/me')).user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function logout(): Promise<void> {
  await request(fetch, 'POST', '/api/auth/logout');
}

export async function listCairns(fetch: Fetch): Promise<Cairn[]> {
  return ListCairnsResponse.parse(await request(fetch, 'GET', '/api/cairns')).cairns;
}

export async function createCairn(input: CreateCairnRequest): Promise<Cairn> {
  return CairnResponse.parse(await request(fetch, 'POST', '/api/cairns', input)).cairn;
}

export async function updateCairn(id: string, input: UpdateCairnRequest): Promise<Cairn> {
  return CairnResponse.parse(await request(fetch, 'PATCH', `/api/cairns/${id}`, input)).cairn;
}

export async function getCairn(fetch: Fetch, id: string): Promise<Cairn> {
  return CairnResponse.parse(await request(fetch, 'GET', `/api/cairns/${id}`)).cairn;
}

export async function listShares(cairnId: string): Promise<Share[]> {
  return ListSharesResponse.parse(await request(fetch, 'GET', `/api/cairns/${cairnId}/shares`))
    .shares;
}

/** Link shares come back with their token, once. */
export async function createShare(
  cairnId: string,
  input: CreateShareRequest,
): Promise<CreateShareResponse> {
  return CreateShareResponse.parse(
    await request(fetch, 'POST', `/api/cairns/${cairnId}/shares`, input),
  );
}

export async function revokeShare(cairnId: string, shareId: string): Promise<void> {
  await request(fetch, 'DELETE', `/api/cairns/${cairnId}/shares/${shareId}`);
}

/** Opens a share link for the signed-in user; returns the cairn id. */
export async function redeemShareLink(token: string): Promise<string> {
  return RedeemShareLinkResponse.parse(
    await request(fetch, 'POST', `/api/share-links/${encodeURIComponent(token)}/redeem`),
  ).cairnId;
}

export async function deleteSource(cairnId: string, sourceId: string): Promise<void> {
  await request(fetch, 'DELETE', `/api/cairns/${cairnId}/sources/${sourceId}`);
}

/** Thrown by addUrl when the cairn already has the page: `source` is that page, to refresh instead. */
export class DuplicateUrlError extends ApiError {
  constructor(
    message: string,
    public source: Source,
  ) {
    super(409, message);
  }
}

/** Adds a web page; the worker fetches it. */
export async function addUrl(cairnId: string, url: string): Promise<Source> {
  const res = await fetch(`/api/cairns/${cairnId}/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (res.status === 202) return SourceResponse.parse(body).source;
  const duplicate = DuplicateUrlResponse.safeParse(body);
  if (res.status === 409 && duplicate.success) {
    throw new DuplicateUrlError(duplicate.data.error, duplicate.data.source);
  }
  throw new ApiError(
    res.status,
    (body as { error?: string }).error ?? `adding failed (${res.status})`,
  );
}

/** Fetches a web page again. */
export async function refreshSource(cairnId: string, sourceId: string): Promise<Source> {
  return SourceResponse.parse(
    await request(fetch, 'POST', `/api/cairns/${cairnId}/sources/${sourceId}/refresh`),
  ).source;
}

/**
 * Uploads one file. XMLHttpRequest rather than fetch, because fetch can't report upload progress.
 * `onProgress` gets 0..1.
 */
export function uploadSource(
  cairnId: string,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<Source> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/cairns/${cairnId}/sources`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = {};
      }
      if (xhr.status === 202) resolve(SourceResponse.parse(body).source);
      else
        reject(
          new ApiError(
            xhr.status,
            (body as { error?: string }).error ?? `upload failed (${xhr.status})`,
          ),
        );
    };
    xhr.onerror = () => reject(new ApiError(0, 'upload failed: network error'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

/**
 * Asks a question and calls `onEvent` for each answer event as it streams in. Sealed cairns answer
 * with SealedAnswerEvents (text only). Errors before the stream (validation, access, rate limit)
 * throw an ApiError; `signal` stops the answer.
 */
export async function askQuestion(
  cairnId: string,
  question: string,
  sealed: boolean,
  onEvent: (event: AnswerEvent | SealedAnswerEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/cairns/${cairnId}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, err.error ?? `asking failed (${res.status})`);
  }
  const schema = sealed ? SealedAnswerEvent : AnswerEvent;
  for await (const data of sseData(res.body)) onEvent(schema.parse(JSON.parse(data)));
}

/** A new quiz question; its answer stays on the server until answerQuiz(). */
export async function newQuizQuestion(
  cairnId: string,
  signal?: AbortSignal,
): Promise<QuizQuestion> {
  const body = await request(fetch, 'POST', `/api/cairns/${cairnId}/quiz`, {}, signal);
  return QuizQuestionResponse.parse(body).question;
}

export async function answerQuiz(
  cairnId: string,
  questionId: string,
  choice: number,
  signal?: AbortSignal,
): Promise<QuizResult> {
  const path = `/api/cairns/${cairnId}/quiz/${questionId}/answer`;
  return QuizResultResponse.parse(await request(fetch, 'POST', path, { choice }, signal)).result;
}
