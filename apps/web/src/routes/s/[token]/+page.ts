import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { ApiError, redeemShareLink } from '#lib/api.ts';
import type { PageLoad } from './$types';

// A share link: signed out, offer sign-in (which comes back here); signed in, open it and go to
// the cairn. Unknown, revoked and expired links all look the same.
export const load: PageLoad = async ({ params, parent }) => {
  const { user } = await parent();
  if (!user) return { state: 'signin' as const };
  let cairnId: string;
  try {
    cairnId = await redeemShareLink(params.token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { state: 'invalid' as const };
    throw err;
  }
  redirect(307, resolve('/cairns/[id]', { id: cairnId }));
};
