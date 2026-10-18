import { listCairns } from '#lib/api.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  return { cairns: user ? await listCairns(fetch) : [] };
};
