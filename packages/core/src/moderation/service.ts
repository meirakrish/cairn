import {
  createLlmClient,
  resolveLlmConfig,
  type CallOptions,
  type LlmClient,
  type LlmClientOptions,
} from '@meirakrish/llm-kit';
import { z } from 'zod';
import {
  CATEGORY_LABELS,
  ModerationAnswer,
  moderationMessages,
  type ModerationCategory,
} from './prompt';

export type ModerationVerdict =
  { allowed: true } | { allowed: false; category: ModerationCategory };

export interface Moderator {
  /** Whether `text` may be stored or answered. Errors (model down) are thrown, never read as allowed. */
  check(text: string, opts?: CallOptions): Promise<ModerationVerdict>;
}

/** MODERATION_ENABLED=false: everything is allowed and no model is called. */
export const allowAll: Moderator = {
  check: () => Promise.resolve({ allowed: true }),
};

/** Characters per model call: about 4k tokens, well inside the chat model's context. */
export const MODERATION_WINDOW = 12_000;

/** Pieces of at most `size` characters, cut at whitespace where possible. */
export function moderationWindows(text: string, size = MODERATION_WINDOW): string[] {
  const windows: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const cut = rest.lastIndexOf(' ', size);
    const at = cut > size / 2 ? cut : size;
    windows.push(rest.slice(0, at));
    rest = rest.slice(at).trimStart();
  }
  if (rest) windows.push(rest);
  return windows;
}

/** Asks a chat model about each window in turn and stops at the first one it blocks. */
export class LlmModerator implements Moderator {
  constructor(
    private llm: LlmClient,
    private windowSize = MODERATION_WINDOW,
  ) {}

  async check(text: string, opts: CallOptions = {}): Promise<ModerationVerdict> {
    for (const window of moderationWindows(text, this.windowSize)) {
      const { category } = await this.llm.structured(ModerationAnswer, moderationMessages(window), {
        ...opts,
        name: 'content_moderation',
      });
      if (category !== 'none') return { allowed: false, category };
    }
    return { allowed: true };
  }
}

/** Text the moderator blocked; the message is safe to show. */
export class BlockedContentError extends Error {
  override name = 'BlockedContentError';
  constructor(readonly category: ModerationCategory) {
    super(blockedMessage(category));
  }
}

export const blockedMessage = (category: ModerationCategory) =>
  `Blocked: ${CATEGORY_LABELS[category]}`;

/** A rejected source's error, shown next to its "Blocked" status. */
export const rejectedReason = (category: ModerationCategory) =>
  `Not added: it contains ${CATEGORY_LABELS[category]}`;

/** Throws BlockedContentError when the moderator blocks `text`. */
export async function assertAllowed(moderator: Moderator, text: string, opts?: CallOptions) {
  const verdict = await moderator.check(text, opts);
  if (!verdict.allowed) throw new BlockedContentError(verdict.category);
}

const Flag = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', '']))
  .transform((v) => (v === '' ? undefined : ['true', '1', 'yes', 'on'].includes(v)));

const ModerationEnv = z.object({
  MODERATION_ENABLED: Flag.optional(),
  MODERATION_MODEL: z.string().trim().optional(),
});

export interface ModerationConfig {
  enabled: boolean;
  /** Undefined: the chat model (LLM_MODEL). */
  model?: string;
}

/** MODERATION_ENABLED (default true) and MODERATION_MODEL (default LLM_MODEL). Empty counts as unset. */
export function resolveModerationConfig(env: NodeJS.ProcessEnv = process.env): ModerationConfig {
  const e = ModerationEnv.parse(env);
  return { enabled: e.MODERATION_ENABLED ?? true, model: e.MODERATION_MODEL || undefined };
}

/**
 * The moderator for `cfg`: allowAll when off, else the chat client `llm` when the model is the same,
 * or a client of its own for MODERATION_MODEL.
 */
export async function createModerator(
  cfg: ModerationConfig,
  llm: LlmClient,
  opts: { env?: NodeJS.ProcessEnv } & LlmClientOptions = {},
): Promise<Moderator> {
  if (!cfg.enabled) return allowAll;
  if (!cfg.model || cfg.model === llm.model) return new LlmModerator(llm);
  const { env, ...clientOpts } = opts;
  return new LlmModerator(
    await createLlmClient(resolveLlmConfig({ model: cfg.model }, env ?? process.env), clientOpts),
  );
}
