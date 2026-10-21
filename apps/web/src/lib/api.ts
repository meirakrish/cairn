import {
  AnswerEvent,
  CairnResponse,
  ListCairnsResponse,
  MeResponse,
  SourceResponse,
  type Cairn,
  type CreateCairnRequest,
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

async function request(fetch: Fetch, method: string, path: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
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

export async function getCairn(fetch: Fetch, id: string): Promise<Cairn> {
  return CairnResponse.parse(await request(fetch, 'GET', `/api/cairns/${id}`)).cairn;
}

export async function deleteSource(cairnId: string, sourceId: string): Promise<void> {
  await request(fetch, 'DELETE', `/api/cairns/${cairnId}/sources/${sourceId}`);
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
 * Asks a question and calls `onEvent` for each answer event as it streams in. Errors before the stream
 * (validation, access, rate limit) throw an ApiError; `signal` stops the answer.
 */
export async function askQuestion(
  cairnId: string,
  question: string,
  onEvent: (event: AnswerEvent) => void,
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
  for await (const data of sseData(res.body)) onEvent(AnswerEvent.parse(JSON.parse(data)));
}
