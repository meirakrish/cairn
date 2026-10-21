import { getMe, listCairns } from '#lib/api.ts';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const prerender = false;

// The sidebar lists the caller's cairns on every page; invalidateAll() refreshes it.
export const load: LayoutLoad = async ({ fetch }) => {
  const user = await getMe(fetch);
  return { user, cairns: user ? await listCairns(fetch) : [] };
};
