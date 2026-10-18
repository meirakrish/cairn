import { getMe } from '#lib/api.ts';
import type { LayoutLoad } from './$types';

export const ssr = false;
export const prerender = false;

export const load: LayoutLoad = async ({ fetch }) => ({ user: await getMe(fetch) });
