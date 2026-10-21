import {
  NotFoundError,
  type Share as ShareRow,
  type ShareService,
  type ShareSummary,
} from '@cairn/core';
import {
  CreateShareRequest,
  type CreateShareResponse,
  type ListSharesResponse,
  type RedeemShareLinkResponse,
  type Share,
} from '@cairn/shared';
import { Router } from 'express';
import { requireUser } from './auth/middleware';
import { idParam } from './cairns';

function toDto(s: ShareSummary): Share {
  return {
    ...s,
    expiresAt: s.expiresAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

// A share just created: nobody has opened it yet.
function summary(s: ShareRow): ShareSummary {
  return {
    id: s.id,
    kind: s.granteeEmail ? 'email' : 'link',
    email: s.granteeEmail,
    role: s.role,
    visibility: s.visibility,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    redeemedBy: [],
  };
}

export interface SharesRouterDeps {
  shares: ShareService;
}

/**
 * Managing a cairn's shares (owner only; ShareService answers 404 to strangers and 403 to grantees),
 * mounted at /api/cairns.
 */
export function sharesRouter({ shares }: SharesRouterDeps) {
  const router = Router();
  router.use(requireUser);

  router.get('/:id/shares', async (req, res) => {
    const list = await shares.list(req.user!.id, idParam(req, 'id', 'cairn'));
    const body: ListSharesResponse = { shares: list.map(toDto) };
    res.json(body);
  });

  router.post('/:id/shares', async (req, res) => {
    const userId = req.user!.id;
    const cairnId = idParam(req, 'id', 'cairn');
    const input = CreateShareRequest.parse(req.body);
    const opts = {
      role: input.role,
      visibility: input.visibility,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    };
    let body: CreateShareResponse;
    if (input.kind === 'email') {
      body = {
        share: toDto(summary(await shares.shareWithEmail(userId, cairnId, input.email, opts))),
      };
    } else {
      const { share, token } = await shares.createLink(userId, cairnId, opts);
      body = { share: toDto(summary(share)), token };
    }
    res.status(201).json(body);
  });

  router.delete('/:id/shares/:shareId', async (req, res) => {
    await shares.revoke(
      req.user!.id,
      idParam(req, 'id', 'cairn'),
      idParam(req, 'shareId', 'share'),
    );
    res.status(204).end();
  });

  return router;
}

/** POST /api/share-links/:token/redeem: the signed-in user opens a share link. */
export function shareLinksRouter({ shares }: SharesRouterDeps) {
  const router = Router();

  router.post('/:token/redeem', requireUser, async (req, res) => {
    const token = req.params.token;
    const cairnId =
      typeof token === 'string' ? await shares.redeem(req.user!.id, token) : undefined;
    // Unknown, revoked and expired links look the same.
    if (!cairnId) throw new NotFoundError('share link');
    const body: RedeemShareLinkResponse = { cairnId };
    res.json(body);
  });

  return router;
}
