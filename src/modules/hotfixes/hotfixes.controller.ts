import type { Request, Response } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { diffFields, logActivity } from '../../services/activity.js';
import { notify } from '../../services/notifications.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { HotfixStatus } from '../../generated/prisma/enums.js';
import { projectEscalationAudience } from '../issues/issues.service.js';
import { phaseSummary, userSummary } from '../shared/selectors.js';
import { nextHotfixKey, nextTaskKey } from '../tasks/tasks.service.js';

const OPEN_STATUSES: HotfixStatus[] = [
  'REQUESTED',
  'APPROVED',
  'IN_PROGRESS',
  'IN_TESTING',
  'READY',
];

const listSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  severity: true,
  priority: true,
  dueDate: true,
  approvedAt: true,
  fixedAt: true,
  testedAt: true,
  deployedAt: true,
  verifiedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, key: true, name: true, color: true } },
  requestedBy: { select: userSummary },
  assignee: { select: userSummary },
  issue: { select: { id: true, key: true, title: true, severity: true, status: true } },
  task: {
    select: {
      id: true,
      key: true,
      title: true,
      qaStatus: true,
      status: { select: { id: true, name: true, category: true, color: true } },
      phase: { select: phaseSummary },
    },
  },
  release: { select: { id: true, version: true, status: true, releasedAt: true } },
  _count: { select: { comments: true, attachments: true } },
} as const;

const detailSelect = {
  ...listSelect,
  description: true,
  rootCause: true,
  resolution: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      url: true,
      mimeType: true,
      bytes: true,
      createdAt: true,
      uploadedBy: { select: userSummary },
    },
  },
} as const;

const shape = <T extends { _count?: Record<string, number>; [k: string]: unknown }>(hotfix: T) => {
  const { _count, ...rest } = hotfix;
  return {
    ...rest,
    counts: { comments: _count?.comments ?? 0, attachments: _count?.attachments ?? 0 },
  };
};

/** Timestamps that make the hotfix timeline auditable. */
const TIMESTAMP_FOR_STATUS: Partial<Record<HotfixStatus, string>> = {
  APPROVED: 'approvedAt',
  READY: 'fixedAt',
  IN_TESTING: 'testedAt',
  DEPLOYED: 'deployedAt',
  VERIFIED: 'verifiedAt',
};

const findRef = async (idOrKey: string) => {
  const hotfix = await prisma.hotfix.findFirst({
    where: { OR: [{ id: idOrKey }, { key: idOrKey.toUpperCase() }] },
    select: { id: true, projectId: true, key: true, project: { select: { key: true } } },
  });
  if (!hotfix) throw notFound('Hotfix not found');
  return hotfix;
};

const hotfixUrl = (projectKey: string, key: string) => `/projects/${projectKey}/hotfixes/${key}`;

export const listHotfixes = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<{
    page: number;
    pageSize: number;
    projectId?: string;
    status?: string[];
    severity?: string[];
    assigneeId?: string[];
    openOnly: boolean;
    search?: string;
    sort: 'createdAt' | 'dueDate' | 'severity' | 'status';
    order: 'asc' | 'desc';
  }>(req);

  const projectIds = query.projectId
    ? [(await auth.requireProject(query.projectId, 'hotfix:view')).projectId]
    : await auth.projectIdsWith('hotfix:view');

  const where: Prisma.HotfixWhereInput = {
    projectId: { in: projectIds },
    ...(query.status
      ? { status: { in: query.status as HotfixStatus[] } }
      : query.openOnly
        ? { status: { in: OPEN_STATUSES } }
        : {}),
    ...(query.severity ? { severity: { in: query.severity as 'MINOR'[] } } : {}),
    ...(query.assigneeId ? { assigneeId: { in: query.assigneeId } } : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { key: { contains: query.search.toUpperCase() } },
          ],
        }
      : {}),
  };

  const [hotfixes, total] = await Promise.all([
    prisma.hotfix.findMany({
      where,
      ...skipTake(query),
      orderBy:
        query.sort === 'dueDate'
          ? [{ dueDate: { sort: query.order, nulls: 'last' } }]
          : query.sort === 'severity'
            ? [{ severity: query.order === 'asc' ? 'asc' : 'desc' }, { createdAt: 'desc' }]
            : query.sort === 'status'
              ? [{ status: query.order }]
              : [{ createdAt: query.order }],
      select: listSelect,
    }),
    prisma.hotfix.count({ where }),
  ]);

  res.json(paged(hotfixes.map(shape), total, query));
};

export const getHotfix = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findRef(String(req.params.hotfixId));
  await auth.requireProject(ref.projectId, 'hotfix:view');
  const hotfix = await prisma.hotfix.findUniqueOrThrow({
    where: { id: ref.id },
    select: detailSelect,
  });
  res.json({ data: shape(hotfix) });
};

export const createHotfix = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    projectId: string;
    title: string;
    description?: string | null;
    severity?: 'CRITICAL';
    priority?: 'CRITICAL';
    issueId?: string | null;
    assigneeId?: string | null;
    releaseId?: string | null;
    dueDate?: Date | null;
    createTask: boolean;
  };

  const access = await auth.requireProject(body.projectId, 'hotfix:create');
  const projectId = access.projectId;

  if (body.issueId) {
    const issue = await prisma.issue.findUnique({
      where: { id: body.issueId },
      select: { projectId: true },
    });
    if (issue?.projectId !== projectId) throw badRequest('That issue is not part of this project');
  }
  if (body.assigneeId) {
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: body.assigneeId } },
      select: { id: true },
    });
    if (!member) throw badRequest('Assign the hotfix to a member of this project');
  }

  const productionPhase = await prisma.projectPhase.findFirst({
    where: { projectId, isProduction: true },
    select: { id: true },
  });

  const hotfix = await prisma.$transaction(async (tx) => {
    const key = await nextHotfixKey(tx, projectId);

    let taskId: string | null = null;
    if (body.createTask) {
      const status =
        (await tx.taskStatus.findFirst({ where: { projectId, isDefault: true }, select: { id: true } })) ??
        (await tx.taskStatus.findFirstOrThrow({
          where: { projectId },
          orderBy: { order: 'asc' },
          select: { id: true },
        }));
      const taskKey = await nextTaskKey(tx, projectId);
      const task = await tx.task.create({
        data: {
          key: taskKey,
          projectId,
          title: `${key} ${body.title}`,
          description: body.description ?? null,
          type: 'HOTFIX',
          priority: body.priority ?? 'CRITICAL',
          statusId: status.id,
          phaseId: productionPhase?.id ?? null,
          qaStatus: 'PENDING',
          reporterId: auth.id,
          ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
          ...(body.assigneeId ? { assignees: { create: { userId: body.assigneeId } } } : {}),
          watchers: { create: { userId: auth.id } },
        },
        select: { id: true },
      });
      taskId = task.id;
    }

    return tx.hotfix.create({
      data: {
        key,
        projectId,
        title: body.title,
        description: body.description ?? null,
        ...(body.severity ? { severity: body.severity } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        issueId: body.issueId ?? null,
        assigneeId: body.assigneeId ?? null,
        releaseId: body.releaseId ?? null,
        taskId,
        requestedById: auth.id,
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      },
      select: detailSelect,
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'hotfix.requested',
    entityType: 'HOTFIX',
    entityId: hotfix.id,
    projectId,
    hotfixId: hotfix.id,
    issueId: body.issueId ?? null,
    taskId: hotfix.task?.id ?? null,
    meta: { key: hotfix.key, title: hotfix.title, severity: hotfix.severity },
  });

  const url = hotfixUrl(access.projectKey, hotfix.key);
  const approvers = await projectEscalationAudience(projectId);

  await notify({
    userIds: [...approvers, ...(body.assigneeId ? [body.assigneeId] : [])],
    event: 'HOTFIX_REQUESTED',
    title: `🔥 Hotfix requested: ${hotfix.key}`,
    body: `${auth.user.name} raised a ${hotfix.severity.toLowerCase()} hotfix — “${hotfix.title}”.`,
    url,
    actorId: auth.id,
    projectId,
    hotfixId: hotfix.id,
    telegramButtons: [
      [
        { text: '✅ Approve', callbackData: `hotfix:approve:${hotfix.id}` },
        { text: '✋ Reject', callbackData: `hotfix:reject:${hotfix.id}` },
      ],
    ],
  });

  res.status(201).json({ data: shape(hotfix) });
};

export const updateHotfix = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findRef(String(req.params.hotfixId));
  const access = await auth.requireProject(ref.projectId, 'hotfix:update');
  const body = req.body as Record<string, unknown>;

  const before = await prisma.hotfix.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      title: true,
      description: true,
      severity: true,
      priority: true,
      status: true,
      issueId: true,
      taskId: true,
      releaseId: true,
      assigneeId: true,
      dueDate: true,
      rootCause: true,
      resolution: true,
    },
  });

  if (body.status && (body.status === 'APPROVED' || body.status === 'REJECTED')) {
    auth.assert('hotfix:approve', 'Only approvers can approve or reject a hotfix');
  }

  const data: Record<string, unknown> = { ...body };
  if (body.status && body.status !== before.status) {
    const field = TIMESTAMP_FOR_STATUS[body.status as HotfixStatus];
    if (field) data[field] = new Date();
  }

  const hotfix = await prisma.hotfix.update({
    where: { id: ref.id },
    data,
    select: detailSelect,
  });

  const changes = diffFields(before as Record<string, unknown>, data, [
    'title',
    'description',
    'severity',
    'priority',
    'status',
    'issueId',
    'taskId',
    'releaseId',
    'assigneeId',
    'dueDate',
    'rootCause',
    'resolution',
  ]);

  if (Object.keys(changes).length) {
    await logActivity({
      actorId: auth.id,
      action: body.status ? 'hotfix.status_changed' : 'hotfix.updated',
      entityType: 'HOTFIX',
      entityId: ref.id,
      projectId: ref.projectId,
      hotfixId: ref.id,
      meta: { changes },
    });
  }

  const url = hotfixUrl(access.projectKey, hotfix.key);
  const audience = [
    hotfix.requestedBy.id,
    ...(hotfix.assignee ? [hotfix.assignee.id] : []),
    ...(await projectEscalationAudience(ref.projectId)),
  ];

  if (body.status && body.status !== before.status) {
    await notify({
      userIds: audience,
      event: 'HOTFIX_STATUS_CHANGED',
      title: `${hotfix.key} → ${String(body.status).toLowerCase().replace('_', ' ')}`,
      body: `${auth.user.name} moved hotfix “${hotfix.title}” to ${String(body.status).toLowerCase().replace('_', ' ')}.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      hotfixId: ref.id,
    });
  }

  if (body.assigneeId && body.assigneeId !== before.assigneeId) {
    await notify({
      userIds: [String(body.assigneeId)],
      event: 'HOTFIX_STATUS_CHANGED',
      title: `🔥 ${hotfix.key} assigned to you`,
      body: `${auth.user.name} asked you to handle “${hotfix.title}”.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      hotfixId: ref.id,
    });
  }

  res.json({ data: shape(hotfix) });
};

export const decide = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findRef(String(req.params.hotfixId));
  const access = await auth.requireProject(ref.projectId, 'hotfix:approve');
  const body = req.body as { approve: boolean; comment?: string };

  const hotfix = await prisma.$transaction(async (tx) => {
    if (body.comment) {
      await tx.comment.create({
        data: {
          body: body.comment,
          entityType: 'HOTFIX',
          authorId: auth.id,
          hotfixId: ref.id,
          projectId: ref.projectId,
        },
      });
    }
    return tx.hotfix.update({
      where: { id: ref.id },
      data: body.approve
        ? { status: 'APPROVED', approvedAt: new Date() }
        : { status: 'REJECTED' },
      select: detailSelect,
    });
  });

  await logActivity({
    actorId: auth.id,
    action: body.approve ? 'hotfix.approved' : 'hotfix.rejected',
    entityType: 'HOTFIX',
    entityId: ref.id,
    projectId: ref.projectId,
    hotfixId: ref.id,
    meta: { comment: body.comment ?? null },
  });

  await notify({
    userIds: [
      hotfix.requestedBy.id,
      ...(hotfix.assignee ? [hotfix.assignee.id] : []),
    ],
    event: 'HOTFIX_STATUS_CHANGED',
    title: `${hotfix.key} ${body.approve ? 'approved' : 'rejected'}`,
    body: `${auth.user.name} ${body.approve ? 'approved' : 'rejected'} “${hotfix.title}”.${body.comment ? ` “${body.comment}”` : ''}`,
    url: hotfixUrl(access.projectKey, hotfix.key),
    actorId: auth.id,
    projectId: ref.projectId,
    hotfixId: ref.id,
  });

  res.json({ data: shape(hotfix) });
};

export const deleteHotfix = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findRef(String(req.params.hotfixId));
  await auth.requireProject(ref.projectId, 'hotfix:delete');
  await prisma.hotfix.delete({ where: { id: ref.id } });
  await logActivity({
    actorId: auth.id,
    action: 'hotfix.deleted',
    entityType: 'HOTFIX',
    entityId: ref.id,
    projectId: ref.projectId,
    meta: { key: ref.key },
  });
  res.status(204).end();
};
