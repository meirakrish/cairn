import type { Cairn as CairnRow, CairnService } from '@cairn/core';
import {
  CreateCairnRequest,
  type Cairn,
  type CairnResponse,
  type ListCairnsResponse,
} from '@cairn/shared';
import { Router } from 'express';
import { requireUser } from './auth/middleware';

function toDto({ id, name, description, embedModel, createdAt }: CairnRow): Cairn {
  return { id, name, description, embedModel, createdAt: createdAt.toISOString() };
}

export function cairnsRouter(cairns: CairnService) {
  const router = Router();
  router.use(requireUser);

  router.get('/', async (req, res) => {
    const body: ListCairnsResponse = { cairns: (await cairns.list(req.user!.id)).map(toDto) };
    res.json(body);
  });

  router.post('/', async (req, res) => {
    const input = CreateCairnRequest.parse(req.body);
    const body: CairnResponse = { cairn: toDto(await cairns.create(req.user!.id, input)) };
    res.status(201).json(body);
  });

  return router;
}
