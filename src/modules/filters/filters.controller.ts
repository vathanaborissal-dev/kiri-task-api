import type { Request, Response } from 'express';
import { forbidden, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { userSummary } from '../shared/selectors.js';

export const listFilters = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  const scope = req.query.scope ? String(req.query.scope) : undefined;

  const accessible = await auth.accessibleProjectIds();

  const filters = await prisma.savedFilter.findMany({
    where: {
      ...(scope ? { scope: scope as 'TASK' } : {}),
      OR: [
        { userId: auth.id },
        { isShared: true, projectId: { in: accessible } },
        { isShared: true, projectId: null },
      ],
      ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    },
    orderBy: [{ isShared: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      scope: true,
      query: true,
      isShared: true,
      projectId: true,
      createdAt: true,
      user: { select: userSummary },
    },
  });

  res.json({
    data: filters.map((f) => ({ ...f, isMine: f.user.id === auth.id })),
  });
};

export const createFilter = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    name: string;
    scope: 'TASK' | 'ISSUE';
    query: Record<string, unknown>;
    projectId?: string | null;
    isShared?: boolean;
  };

  if (body.projectId) await auth.requireProject(body.projectId, 'project:view');

  const filter = await prisma.savedFilter.create({
    data: {
      name: body.name,
      scope: body.scope,
      query: body.query as object,
      projectId: body.projectId ?? null,
      isShared: body.isShared ?? false,
      userId: auth.id,
    },
  });

  res.status(201).json({ data: filter });
};

export const updateFilter = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = String(req.params.filterId);
  const existing = await prisma.savedFilter.findUnique({ where: { id } });
  if (!existing) throw notFound('Filter not found');
  if (existing.userId !== auth.id) throw forbidden('You can only edit your own saved filters');

  const body = req.body as Record<string, unknown>;
  const filter = await prisma.savedFilter.update({
    where: { id },
    data: { ...body, ...(body.query ? { query: body.query as object } : {}) },
  });
  res.json({ data: filter });
};

export const deleteFilter = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = String(req.params.filterId);
  const existing = await prisma.savedFilter.findUnique({ where: { id } });
  if (!existing) throw notFound('Filter not found');
  if (existing.userId !== auth.id) throw forbidden('You can only delete your own saved filters');
  await prisma.savedFilter.delete({ where: { id } });
  res.status(204).end();
};
