import { MeResponse, type User } from '@cairn/shared';

export async function getMe(fetch: typeof globalThis.fetch): Promise<User | null> {
  const res = await fetch('/api/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GET /api/auth/me: ${res.status}`);
  return MeResponse.parse(await res.json()).user;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}
