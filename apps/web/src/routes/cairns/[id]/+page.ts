import { error, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { ApiError, getCairn } from '#lib/api.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, parent }) => {
  const { user } = await parent();
  if (!user) redirect(307, resolve('/'));
  try {
    return { cairn: await getCairn(fetch, params.id) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) error(404, 'Cairn not found');
    throw err;
  }
};
