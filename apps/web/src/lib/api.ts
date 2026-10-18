import {
  CairnResponse,
  ListCairnsResponse,
  MeResponse,
  type Cairn,
  type CreateCairnRequest,
  type User,
} from '@cairn/shared';

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
