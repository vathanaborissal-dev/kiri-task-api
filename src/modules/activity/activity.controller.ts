import type { Request, Response } from 'express';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { EntityType } from '../../generated/prisma/enums.js';
import { userSummary } from '../shared/selectors.js';

const select = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  meta: true,
  createdAt: true,
  actor: { select: userSummary },
  project: { select: { id: true, key: true, name: true, color: true } },
  task: { select: { id: true, key: true, title: true } },
  issue: { select: { id: true, key: true, title: true } },
  release: { select: { id: true, version: true } },
  hotfix: { select: { id: true, key: true, title: true } },
} as const;

export const listActivity = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<{
    page: number;
    pageSize: number;
    projectId?: string;
    taskId?: string;
    issueId?: string;
    hotfixId?: string;
    releaseId?: string;
    actorId?: string;
    entityType?: string;
    action?: string;
  }>(req);

  let where: Prisma.ActivityLogWhereInput;

  if (query.projectId) {
    const access = await auth.requireProject(query.projectId, 'activity:view');
    where = { projectId: access.projectId };
  } else if (query.taskId) {
    const task = await prisma.task.findFirst({
      where: { OR: [{ id: query.taskId }, { key: query.taskId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!task) {
      res.json(paged([], 0, query));
      return;
    }
    await auth.requireProject(task.projectId, 'activity:view');
    where = { taskId: task.id };
  } else if (query.issueId) {
    const issue = await prisma.issue.findFirst({
      where: { OR: [{ id: query.issueId }, { key: query.issueId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!issue) {
      res.json(paged([], 0, query));
      return;
    }
    await auth.requireProject(issue.projectId, 'activity:view');
    where = { issueId: issue.id };
  } else if (query.hotfixId) {
    const hotfix = await prisma.hotfix.findFirst({
      where: { OR: [{ id: query.hotfixId }, { key: query.hotfixId.toUpperCase() }] },
      select: { id: true, projectId: true },
    });
    if (!hotfix) {
      res.json(paged([], 0, query));
      return;
    }
    await auth.requireProject(hotfix.projectId, 'activity:view');
    where = { hotfixId: hotfix.id };
  } else if (query.releaseId) {
    const release = await prisma.release.findUnique({
      where: { id: query.releaseId },
      select: { projectId: true },
    });
    if (!release) {
      res.json(paged([], 0, query));
      return;
    }
    await auth.requireProject(release.projectId, 'activity:view');
    where = { releaseId: query.releaseId };
  } else {
    const projectIds = await auth.projectIdsWith('activity:view');
    where = { projectId: { in: projectIds } };
  }

  if (query.actorId) where.actorId = query.actorId;
  if (query.entityType) where.entityType = query.entityType as EntityType;
  if (query.action) where.action = { startsWith: query.action };

  const [activities, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      ...skipTake(query),
      orderBy: { createdAt: 'desc' },
      select,
    }),
    prisma.activityLog.count({ where }),
  ]);

  res.json(paged(activities, total, query));
};

/** Workspace-wide audit trail, including security events with no project. */
export const listAudit = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  auth.assert('audit:view');
  const query = q<{
    page: number;
    pageSize: number;
    actorId?: string;
    action?: string;
    entityType?: string;
  }>(req);

  const where: Prisma.ActivityLogWhereInput = {
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.action ? { action: { startsWith: query.action } } : {}),
    ...(query.entityType ? { entityType: query.entityType as EntityType } : {}),
  };

  const [activities, total] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      ...skipTake(query),
      orderBy: { createdAt: 'desc' },
      select,
    }),
    prisma.activityLog.count({ where }),
  ]);

  res.json(paged(activities, total, query));
};
