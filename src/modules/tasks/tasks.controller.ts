import type { Request, Response } from 'express';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { diffFields, logActivity } from '../../services/activity.js';
import { changedFieldNames, shortDescription } from '../../services/notificationCopy.js';
import { notify } from '../../services/notifications.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { LinkType } from '../../generated/prisma/enums.js';
import * as svc from './tasks.service.js';

type ListQuery = {
  page: number;
  pageSize: number;
  projectId?: string;
  search?: string;
  statusId?: string[];
  statusCategory?: string[];
  priority?: string[];
  type?: string[];
  qaStatus?: string[];
  phaseId?: string[];
  assigneeId?: string[];
  reporterId?: string;
  labelId?: string[];
  milestoneId?: string;
  releaseId?: string;
  parentTaskId?: string;
  topLevelOnly: boolean;
  unassigned?: boolean;
  overdue?: boolean;
  dueFrom?: Date | null;
  dueTo?: Date | null;
  dueWithinDays?: number;
  includeDone: boolean;
  sort: 'position' | 'dueDate' | 'priority' | 'createdAt' | 'updatedAt' | 'title' | 'key';
  order: 'asc' | 'desc';
  groupBy: 'none' | 'status' | 'assignee' | 'priority' | 'phase' | 'milestone';
};

const PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

const buildWhere = async (req: Request, query: ListQuery): Promise<Prisma.TaskWhereInput> => {
  const auth = getAuth(req);

  let projectIds: string[];
  if (query.projectId) {
    const access = await auth.requireProject(query.projectId, 'task:view');
    projectIds = [access.projectId];
  } else {
    projectIds = await auth.projectIdsWith('task:view');
  }

  const dueTo =
    query.dueWithinDays !== undefined
      ? new Date(Date.now() + query.dueWithinDays * 24 * 60 * 60 * 1000)
      : query.dueTo ?? undefined;

  return {
    projectId: { in: projectIds },
    ...(query.topLevelOnly ? { parentTaskId: null } : {}),
    ...(query.parentTaskId ? { parentTaskId: query.parentTaskId } : {}),
    ...(query.statusId ? { statusId: { in: query.statusId } } : {}),
    ...(query.statusCategory
      ? { status: { category: { in: query.statusCategory as 'TODO'[] } } }
      : query.includeDone
        ? {}
        : { status: { category: { notIn: ['DONE', 'CANCELED'] } } }),
    ...(query.priority ? { priority: { in: query.priority as 'LOW'[] } } : {}),
    ...(query.type ? { type: { in: query.type as 'TASK'[] } } : {}),
    ...(query.qaStatus ? { qaStatus: { in: query.qaStatus as 'PENDING'[] } } : {}),
    ...(query.phaseId
      ? query.phaseId.includes('none')
        ? { phaseId: null }
        : { phaseId: { in: query.phaseId } }
      : {}),
    ...(query.assigneeId ? { assignees: { some: { userId: { in: query.assigneeId } } } } : {}),
    ...(query.unassigned ? { assignees: { none: {} } } : {}),
    ...(query.reporterId ? { reporterId: query.reporterId } : {}),
    ...(query.labelId ? { labels: { some: { labelId: { in: query.labelId } } } } : {}),
    ...(query.milestoneId
      ? query.milestoneId === 'none'
        ? { milestoneId: null }
        : { milestoneId: query.milestoneId }
      : {}),
    ...(query.releaseId
      ? query.releaseId === 'none'
        ? { releaseId: null }
        : { releaseId: query.releaseId }
      : {}),
    ...(query.overdue
      ? { dueDate: { lt: new Date() }, status: { category: { notIn: ['DONE', 'CANCELED'] } } }
      : {}),
    ...(query.dueFrom || dueTo
      ? {
          dueDate: {
            ...(query.dueFrom ? { gte: query.dueFrom } : {}),
            ...(dueTo ? { lte: dueTo } : {}),
          },
        }
      : {}),
    ...(query.search
      ? {
          OR: [
            { title: { contains: query.search, mode: 'insensitive' } },
            { description: { contains: query.search, mode: 'insensitive' } },
            { key: { contains: query.search.toUpperCase() } },
          ],
        }
      : {}),
  };
};

const orderBy = (query: ListQuery): Prisma.TaskOrderByWithRelationInput[] => {
  switch (query.sort) {
    case 'dueDate':
      return [{ dueDate: { sort: query.order, nulls: 'last' } }, { priority: 'desc' }];
    case 'priority':
      return [{ priority: query.order === 'asc' ? 'desc' : 'asc' }, { dueDate: 'asc' }];
    case 'createdAt':
      return [{ createdAt: query.order }];
    case 'updatedAt':
      return [{ updatedAt: query.order }];
    case 'title':
      return [{ title: query.order }];
    case 'key':
      return [{ createdAt: query.order }];
    default:
      return [{ position: query.order }, { createdAt: 'desc' }];
  }
};

export const listTasks = async (req: Request, res: Response) => {
  const query = q<ListQuery>(req);
  const where = await buildWhere(req, query);

  const [tasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      ...skipTake(query),
      orderBy: orderBy(query),
      select: svc.taskListSelect,
    }),
    prisma.task.count({ where }),
  ]);

  const data = tasks.map(svc.shapeTask);

  if (query.groupBy === 'none') {
    res.json(paged(data, total, query));
    return;
  }

  const groups = new Map<string, { key: string; label: string; color?: string; tasks: unknown[] }>();
  for (const task of data) {
    let key = 'none';
    let label = 'Unassigned';
    let color: string | undefined;

    if (query.groupBy === 'status') {
      key = task.status.id;
      label = task.status.name;
      color = task.status.color;
    } else if (query.groupBy === 'priority') {
      key = task.priority;
      label = task.priority;
    } else if (query.groupBy === 'phase') {
      key = task.phase?.id ?? 'none';
      label = task.phase?.name ?? 'No phase';
      color = task.phase?.color;
    } else if (query.groupBy === 'milestone') {
      key = task.milestone?.id ?? 'none';
      label = task.milestone?.name ?? 'No milestone';
    } else if (query.groupBy === 'assignee') {
      const first = task.assignees[0] as { id: string; name: string } | undefined;
      key = first?.id ?? 'none';
      label = first?.name ?? 'Unassigned';
    }

    if (!groups.has(key)) groups.set(key, { key, label, color, tasks: [] });
    groups.get(key)!.tasks.push(task);
  }

  res.json({
    data: [...groups.values()],
    meta: { page: query.page, pageSize: query.pageSize, total, grouped: true },
  });
};

/** Kanban payload: every column, with its tasks in board order. */
export const getBoard = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.query.projectId ?? ''), 'task:view');
  const query = q<ListQuery>(req);
  const where = await buildWhere(req, { ...query, projectId: access.projectId, sort: 'position' });

  const [statuses, tasks] = await Promise.all([
    prisma.taskStatus.findMany({
      where: { projectId: access.projectId },
      orderBy: { order: 'asc' },
    }),
    prisma.task.findMany({
      where,
      orderBy: [{ position: 'asc' }, { createdAt: 'desc' }],
      select: svc.taskListSelect,
      take: 1000,
    }),
  ]);

  const byStatus = new Map<string, unknown[]>(statuses.map((s) => [s.id, []]));
  for (const task of tasks) {
    byStatus.get(task.status.id)?.push(svc.shapeTask(task));
  }

  res.json({
    data: statuses.map((status) => ({
      status,
      tasks: byStatus.get(status.id) ?? [],
      count: (byStatus.get(status.id) ?? []).length,
    })),
  });
};

export const getTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:view');

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: svc.taskDetailSelect,
  });

  const shaped = svc.shapeTask(task);
  res.json({
    data: {
      ...shaped,
      links: [
        ...task.linksFrom.map((l) => ({ id: l.id, type: l.type, task: l.target, direction: 'out' })),
        ...task.linksTo.map((l) => ({ id: l.id, type: l.type, task: l.source, direction: 'in' })),
      ],
      linksFrom: undefined,
      linksTo: undefined,
    },
  });
};

export const createTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    projectId: string;
    title: string;
    description?: string | null;
    type?: 'TASK';
    priority?: 'MEDIUM';
    statusId?: string;
    phaseId?: string | null;
    qaStatus?: 'PENDING';
    parentTaskId?: string | null;
    milestoneId?: string | null;
    releaseId?: string | null;
    assigneeIds?: string[];
    labelIds?: string[];
    startDate?: Date | null;
    dueDate?: Date | null;
    estimateHours?: number | null;
    checklist?: string[];
  };

  const access = await auth.requireProject(body.projectId, 'task:create');
  const projectId = access.projectId;

  if (body.assigneeIds?.length && !access.permissions.has('task:assign') && !auth.isSuperAdmin) {
    const onlySelf = body.assigneeIds.every((id) => id === auth.id);
    if (!onlySelf) throw forbidden('You can only assign tasks to yourself');
  }
  if (body.dueDate && !access.permissions.has('task:manage_deadline') && !auth.isSuperAdmin) {
    throw forbidden('You cannot set deadlines on this project');
  }

  await svc.assertProjectScope(projectId, body);

  const statusId =
    body.statusId ??
    (
      await prisma.taskStatus.findFirst({
        where: { projectId, isDefault: true },
        select: { id: true },
      })
    )?.id ??
    (
      await prisma.taskStatus.findFirstOrThrow({
        where: { projectId },
        orderBy: { order: 'asc' },
        select: { id: true },
      })
    ).id;

  const position = await svc.positionForTop(projectId, statusId);

  const task = await prisma.$transaction(async (tx) => {
    const key = await svc.nextTaskKey(tx, projectId);
    return tx.task.create({
      data: {
        key,
        projectId,
        title: body.title,
        description: body.description ?? null,
        ...(body.type ? { type: body.type } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        statusId,
        phaseId: body.phaseId ?? null,
        ...(body.qaStatus ? { qaStatus: body.qaStatus } : {}),
        parentTaskId: body.parentTaskId ?? null,
        milestoneId: body.milestoneId ?? null,
        releaseId: body.releaseId ?? null,
        reporterId: auth.id,
        ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.estimateHours !== undefined ? { estimateHours: body.estimateHours } : {}),
        position,
        ...(body.assigneeIds?.length
          ? { assignees: { create: body.assigneeIds.map((userId) => ({ userId })) } }
          : {}),
        ...(body.labelIds?.length
          ? { labels: { create: body.labelIds.map((labelId) => ({ labelId })) } }
          : {}),
        ...(body.checklist?.length
          ? {
              checklist: {
                create: body.checklist.map((title, order) => ({ title, order })),
              },
            }
          : {}),
        watchers: { create: { userId: auth.id } },
      },
      select: svc.taskDetailSelect,
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'task.created',
    entityType: 'TASK',
    entityId: task.id,
    projectId,
    taskId: task.id,
    meta: { key: task.key, title: task.title },
  });

  if (body.assigneeIds?.length) {
    await notify({
      userIds: body.assigneeIds,
      event: 'TASK_ASSIGNED',
      title: `${task.key}: ${task.title}`,
      body: [
        `Assigned by: ${auth.user.name}`,
        `Type: ${task.type.toLowerCase()}`,
        `Description: ${shortDescription(task.description)}`,
      ].join('\n'),
      url: svc.taskUrl(access.projectKey, task.key),
      actorId: auth.id,
      projectId,
      taskId: task.id,
      telegramButtons: [
        [
          { text: '▶️ Start', callbackData: `task:start:${task.id}` },
          { text: '✅ Done', callbackData: `task:done:${task.id}` },
        ],
      ],
    });
  }

  res.status(201).json({ data: svc.shapeTask(task) });
};

export const updateTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:view');
  const body = req.body as Record<string, unknown>;

  const before = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      type: true,
      priority: true,
      statusId: true,
      phaseId: true,
      qaStatus: true,
      milestoneId: true,
      releaseId: true,
      parentTaskId: true,
      startDate: true,
      dueDate: true,
      estimateHours: true,
      spentHours: true,
      status: { select: { name: true, category: true } },
      assignees: { select: { userId: true } },
    },
  });

  const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);

  const touchesStatus = body.statusId !== undefined && body.statusId !== before.statusId;
  const touchesPhase = body.phaseId !== undefined && body.phaseId !== before.phaseId;
  const touchesQa = body.qaStatus !== undefined && body.qaStatus !== before.qaStatus;
  const touchesDates =
    (body.dueDate !== undefined && String(body.dueDate) !== String(before.dueDate)) ||
    (body.startDate !== undefined && String(body.startDate) !== String(before.startDate));
  const touchesAssignees = body.assigneeIds !== undefined;
  const touchesOther = Object.keys(body).some(
    (k) => !['statusId', 'phaseId', 'qaStatus', 'dueDate', 'startDate', 'assigneeIds'].includes(k),
  );

  if (touchesStatus && !can('task:change_status')) throw forbidden('You cannot change task status');
  if (touchesPhase && !can('task:manage_phase')) throw forbidden('You cannot change the phase');
  if (touchesQa && !can('task:manage_qa')) throw forbidden('You cannot change the testing status');
  if (touchesDates && !can('task:manage_deadline')) throw forbidden('You cannot change deadlines');
  if (touchesOther && !can('task:update')) throw forbidden('You cannot edit this task');
  if (touchesAssignees) {
    const next = body.assigneeIds as string[];
    const onlySelf =
      next.length <= 1 && next.every((id) => id === auth.id) &&
      before.assignees.every((a) => a.userId === auth.id);
    if (!can('task:assign') && !onlySelf) throw forbidden('You cannot assign this task');
  }

  await svc.assertProjectScope(ref.projectId, {
    statusId: body.statusId as string | undefined,
    phaseId: body.phaseId as string | null | undefined,
    milestoneId: body.milestoneId as string | null | undefined,
    releaseId: body.releaseId as string | null | undefined,
    parentTaskId: body.parentTaskId as string | null | undefined,
    labelIds: body.labelIds as string[] | undefined,
    assigneeIds: body.assigneeIds as string[] | undefined,
  });

  if (body.parentTaskId && body.parentTaskId === ref.id) {
    throw badRequest('A task cannot be its own parent');
  }

  const { labelIds, assigneeIds, ...scalars } = body as {
    labelIds?: string[];
    assigneeIds?: string[];
  } & Record<string, unknown>;

  let completedAt: Date | null | undefined;
  if (touchesStatus) {
    const nextStatus = await prisma.taskStatus.findUniqueOrThrow({
      where: { id: String(body.statusId) },
      select: { category: true, name: true },
    });
    completedAt = nextStatus.category === 'DONE' ? new Date() : null;
  }

  const task = await prisma.$transaction(async (tx) => {
    if (labelIds) {
      await tx.taskLabel.deleteMany({ where: { taskId: ref.id } });
      if (labelIds.length) {
        await tx.taskLabel.createMany({
          data: labelIds.map((labelId) => ({ taskId: ref.id, labelId })),
        });
      }
    }
    if (assigneeIds) {
      await tx.taskAssignee.deleteMany({ where: { taskId: ref.id } });
      if (assigneeIds.length) {
        await tx.taskAssignee.createMany({
          data: assigneeIds.map((userId) => ({ taskId: ref.id, userId })),
        });
        await tx.taskWatcher.createMany({
          data: assigneeIds.map((userId) => ({ taskId: ref.id, userId })),
          skipDuplicates: true,
        });
      }
    }
    return tx.task.update({
      where: { id: ref.id },
      data: { ...scalars, ...(completedAt !== undefined ? { completedAt } : {}) },
      select: svc.taskDetailSelect,
    });
  });

  const changes = diffFields(before as Record<string, unknown>, scalars, [
    'title',
    'description',
    'type',
    'priority',
    'statusId',
    'phaseId',
    'qaStatus',
    'milestoneId',
    'releaseId',
    'startDate',
    'dueDate',
    'estimateHours',
    'spentHours',
  ]);

  const audience = await svc.taskAudience(ref.id);
  const url = svc.taskUrl(access.projectKey, task.key);
  const beforeAssigneeIds = before.assignees.map((assignee) => assignee.userId);
  const currentAssigneeIds = task.assignees.map((assignee) => assignee.user.id);
  const addedAssigneeIds = assigneeIds
    ? currentAssigneeIds.filter((id) => !beforeAssigneeIds.includes(id))
    : [];
  const removedAssigneeIds = assigneeIds
    ? beforeAssigneeIds.filter((id) => !currentAssigneeIds.includes(id))
    : [];

  if (Object.keys(changes).length > 0 || assigneeIds || labelIds) {
    await logActivity({
      actorId: auth.id,
      action: touchesStatus ? 'task.status_changed' : 'task.updated',
      entityType: 'TASK',
      entityId: ref.id,
      projectId: ref.projectId,
      taskId: ref.id,
      meta: {
        changes,
        ...(touchesStatus
          ? { statusFrom: before.status.name, statusTo: task.status.name }
          : {}),
        ...(assigneeIds ? { assigneeIds } : {}),
      },
    });
  }

  if (touchesStatus) {
    await notify({
      userIds: audience,
      event: 'TASK_STATUS_CHANGED',
      title: `${task.key} moved to ${task.status.name}`,
      body: `${auth.user.name} moved “${task.title}” from ${before.status.name} to ${task.status.name}.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: ref.id,
    });
  }

  if (touchesPhase && task.phase) {
    await notify({
      userIds: audience,
      event: 'TASK_PHASE_CHANGED',
      title: `${task.key} reached ${task.phase.name}`,
      body: `${auth.user.name} promoted “${task.title}” to ${task.phase.name}.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: ref.id,
    });
  }

  const editedFields = [
    ...Object.keys(changes).filter((field) => field !== 'statusId' && field !== 'phaseId'),
    ...(labelIds ? ['labelIds'] : []),
    ...(assigneeIds ? ['assigneeIds'] : []),
  ];
  const addedSet = new Set(addedAssigneeIds);
  if (editedFields.length > 0) {
    await notify({
      userIds: currentAssigneeIds.filter((id) => !addedSet.has(id)),
      event: 'TASK_UPDATED',
      title: `${task.key} was updated`,
      body: [
        `Updated by: ${auth.user.name}`,
        `Changed: ${changedFieldNames(editedFields)}`,
        `Description: ${shortDescription(task.description)}`,
      ].join('\n'),
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: ref.id,
    });
  }

  if (assigneeIds) {
    if (addedAssigneeIds.length) {
      await notify({
        userIds: addedAssigneeIds,
        event: 'TASK_ASSIGNED',
        title: `${task.key}: ${task.title}`,
        body: [
          `Assigned by: ${auth.user.name}`,
          `Description: ${shortDescription(task.description)}`,
        ].join('\n'),
        url,
        actorId: auth.id,
        projectId: ref.projectId,
        taskId: ref.id,
        telegramButtons: [
          [
            { text: '▶️ Start', callbackData: `task:start:${task.id}` },
            { text: '✅ Done', callbackData: `task:done:${task.id}` },
          ],
        ],
      });
    }
    if (removedAssigneeIds.length) {
      await notify({
        userIds: removedAssigneeIds,
        event: 'TASK_UNASSIGNED',
        title: `You were removed from ${task.key}`,
        body: `${auth.user.name} removed you from “${task.title}”.`,
        url,
        actorId: auth.id,
        projectId: ref.projectId,
        taskId: ref.id,
      });
    }
  }

  res.json({ data: svc.shapeTask(task) });
};

export const moveTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:change_status');
  const body = req.body as { statusId: string; afterTaskId?: string | null };

  await svc.assertProjectScope(ref.projectId, { statusId: body.statusId });

  const before = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: { statusId: true, title: true, key: true, status: { select: { name: true } } },
  });

  const position = await svc.positionAfter(ref.projectId, body.statusId, body.afterTaskId);
  const nextStatus = await prisma.taskStatus.findUniqueOrThrow({
    where: { id: body.statusId },
    select: { category: true, name: true },
  });

  const task = await prisma.task.update({
    where: { id: ref.id },
    data: {
      statusId: body.statusId,
      position,
      completedAt: nextStatus.category === 'DONE' ? new Date() : null,
    },
    select: svc.taskListSelect,
  });

  if (before.statusId !== body.statusId) {
    await logActivity({
      actorId: auth.id,
      action: 'task.status_changed',
      entityType: 'TASK',
      entityId: ref.id,
      projectId: ref.projectId,
      taskId: ref.id,
      meta: { statusFrom: before.status.name, statusTo: nextStatus.name },
    });

    await notify({
      userIds: await svc.taskAudience(ref.id),
      event: 'TASK_STATUS_CHANGED',
      title: `${before.key} moved to ${nextStatus.name}`,
      body: `${auth.user.name} moved “${before.title}” to ${nextStatus.name}.`,
      url: svc.taskUrl(access.projectKey, before.key),
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: ref.id,
    });
  }

  res.json({ data: svc.shapeTask(task) });
};

export const deleteTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:delete');

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      key: true,
      title: true,
      description: true,
      assignees: { select: { userId: true } },
      _count: { select: { subtasks: true } },
    },
  });

  await prisma.task.delete({ where: { id: ref.id } });
  await logActivity({
    actorId: auth.id,
    action: 'task.deleted',
    entityType: 'TASK',
    entityId: ref.id,
    projectId: ref.projectId,
    meta: { key: task.key, title: task.title, subtasksRemoved: task._count.subtasks },
  });

  await notify({
    userIds: task.assignees.map((assignee) => assignee.userId),
    event: 'TASK_DELETED',
    title: `${task.key} was deleted`,
    body: [
      `Deleted by: ${auth.user.name}`,
      `Title: ${task.title}`,
      `Description: ${shortDescription(task.description)}`,
    ].join('\n'),
    url: `/projects/${access.projectKey}/tasks`,
    actorId: auth.id,
    projectId: ref.projectId,
  });

  res.status(204).end();
};

export const bulkUpdate = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    taskIds: string[];
    statusId?: string;
    priority?: 'LOW';
    phaseId?: string | null;
    qaStatus?: 'PENDING';
    milestoneId?: string | null;
    releaseId?: string | null;
    dueDate?: Date | null;
    addAssigneeIds?: string[];
    removeAssigneeIds?: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  };

  const tasks = await prisma.task.findMany({
    where: { id: { in: body.taskIds } },
    select: {
      id: true,
      projectId: true,
      key: true,
      title: true,
      description: true,
      project: { select: { key: true } },
      assignees: { select: { userId: true } },
    },
  });
  if (tasks.length === 0) throw notFound('No matching tasks');

  const projectIds = [...new Set(tasks.map((t) => t.projectId))];
  for (const projectId of projectIds) {
    const access = await auth.requireProject(projectId, 'task:update');
    if (body.statusId && !auth.isSuperAdmin && !access.permissions.has('task:change_status')) {
      throw forbidden('You cannot change task status on one of these projects');
    }
    if (
      (body.addAssigneeIds?.length || body.removeAssigneeIds?.length) &&
      !auth.isSuperAdmin &&
      !access.permissions.has('task:assign')
    ) {
      throw forbidden('You cannot assign tasks on one of these projects');
    }
    if (body.dueDate !== undefined && !auth.isSuperAdmin && !access.permissions.has('task:manage_deadline')) {
      throw forbidden('You cannot change deadlines on one of these projects');
    }
  }

  if (projectIds.length > 1 && (body.statusId || body.phaseId || body.milestoneId || body.releaseId)) {
    throw badRequest('Statuses, phases, milestones and releases are project-specific — bulk edit one project at a time');
  }

  const scalars: Record<string, unknown> = {};
  if (body.statusId) scalars.statusId = body.statusId;
  if (body.priority) scalars.priority = body.priority;
  if (body.phaseId !== undefined) scalars.phaseId = body.phaseId;
  if (body.qaStatus) scalars.qaStatus = body.qaStatus;
  if (body.milestoneId !== undefined) scalars.milestoneId = body.milestoneId;
  if (body.releaseId !== undefined) scalars.releaseId = body.releaseId;
  if (body.dueDate !== undefined) scalars.dueDate = body.dueDate;

  if (Object.keys(scalars).length) {
    await svc.assertProjectScope(projectIds[0]!, {
      statusId: body.statusId,
      phaseId: body.phaseId,
      milestoneId: body.milestoneId,
      releaseId: body.releaseId,
    });
  }

  const ids = tasks.map((t) => t.id);

  await prisma.$transaction(async (tx) => {
    if (Object.keys(scalars).length) {
      await tx.task.updateMany({ where: { id: { in: ids } }, data: scalars });
    }
    if (body.removeAssigneeIds?.length) {
      await tx.taskAssignee.deleteMany({
        where: { taskId: { in: ids }, userId: { in: body.removeAssigneeIds } },
      });
    }
    if (body.addAssigneeIds?.length) {
      await tx.taskAssignee.createMany({
        data: ids.flatMap((taskId) => body.addAssigneeIds!.map((userId) => ({ taskId, userId }))),
        skipDuplicates: true,
      });
    }
    if (body.removeLabelIds?.length) {
      await tx.taskLabel.deleteMany({
        where: { taskId: { in: ids }, labelId: { in: body.removeLabelIds } },
      });
    }
    if (body.addLabelIds?.length) {
      await tx.taskLabel.createMany({
        data: ids.flatMap((taskId) => body.addLabelIds!.map((labelId) => ({ taskId, labelId }))),
        skipDuplicates: true,
      });
    }
  });

  await logActivity({
    actorId: auth.id,
    action: 'task.bulk_updated',
    entityType: 'TASK',
    entityId: ids[0]!,
    projectId: projectIds[0]!,
    meta: { count: ids.length, fields: Object.keys(body).filter((k) => k !== 'taskIds') },
  });

  const currentAssignments = await prisma.taskAssignee.findMany({
    where: { taskId: { in: ids } },
    select: { taskId: true, userId: true },
  });
  const currentByTask = new Map<string, string[]>();
  for (const assignment of currentAssignments) {
    const current = currentByTask.get(assignment.taskId) ?? [];
    current.push(assignment.userId);
    currentByTask.set(assignment.taskId, current);
  }

  const editedFields = Object.keys(body).filter((field) => field !== 'taskIds');
  for (const task of tasks) {
    const beforeIds = task.assignees.map((assignee) => assignee.userId);
    const currentIds = currentByTask.get(task.id) ?? [];
    const addedIds = currentIds.filter((id) => !beforeIds.includes(id));
    const removedIds = beforeIds.filter((id) => !currentIds.includes(id));
    const url = svc.taskUrl(task.project.key, task.key);

    if (editedFields.length > 0) {
      const addedSet = new Set(addedIds);
      await notify({
        userIds: currentIds.filter((id) => !addedSet.has(id)),
        event: 'TASK_UPDATED',
        title: `${task.key} was updated`,
        body: [
          `Updated by: ${auth.user.name}`,
          `Changed: ${changedFieldNames(editedFields)}`,
          `Description: ${shortDescription(task.description)}`,
        ].join('\n'),
        url,
        actorId: auth.id,
        projectId: task.projectId,
        taskId: task.id,
      });
    }

    if (addedIds.length > 0) {
      await notify({
        userIds: addedIds,
        event: 'TASK_ASSIGNED',
        title: `${task.key}: ${task.title}`,
        body: [
          `Assigned by: ${auth.user.name}`,
          `Description: ${shortDescription(task.description)}`,
        ].join('\n'),
        url,
        actorId: auth.id,
        projectId: task.projectId,
        taskId: task.id,
        telegramButtons: [
          [
            { text: '▶️ Start', callbackData: `task:start:${task.id}` },
            { text: '✅ Done', callbackData: `task:done:${task.id}` },
          ],
        ],
      });
    }

    if (removedIds.length > 0) {
      await notify({
        userIds: removedIds,
        event: 'TASK_UNASSIGNED',
        title: `You were removed from ${task.key}`,
        body: `${auth.user.name} removed you from “${task.title}”.`,
        url,
        actorId: auth.id,
        projectId: task.projectId,
        taskId: task.id,
      });
    }
  }

  res.json({ updated: ids.length });
};

// --- Watchers --------------------------------------------------------------

export const toggleWatch = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:view');

  const existing = await prisma.taskWatcher.findUnique({
    where: { taskId_userId: { taskId: ref.id, userId: auth.id } },
  });

  if (existing) {
    await prisma.taskWatcher.delete({
      where: { taskId_userId: { taskId: ref.id, userId: auth.id } },
    });
    res.json({ watching: false });
    return;
  }

  await prisma.taskWatcher.create({ data: { taskId: ref.id, userId: auth.id } });
  res.json({ watching: true });
};

// --- Checklist -------------------------------------------------------------

export const addChecklistItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:update');
  const body = req.body as { title: string; assigneeId?: string | null; dueDate?: Date | null };

  const last = await prisma.checklistItem.findFirst({
    where: { taskId: ref.id },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const item = await prisma.checklistItem.create({
    data: {
      taskId: ref.id,
      title: body.title,
      assigneeId: body.assigneeId ?? null,
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
      order: (last?.order ?? -1) + 1,
    },
    include: { assignee: { select: { id: true, name: true, avatarUrl: true } } },
  });

  res.status(201).json({ data: item });
};

export const updateChecklistItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:update');
  const itemId = String(req.params.itemId);

  const existing = await prisma.checklistItem.findUnique({ where: { id: itemId } });
  if (!existing || existing.taskId !== ref.id) throw notFound('Checklist item not found');

  const body = req.body as Record<string, unknown> & { isDone?: boolean };
  const item = await prisma.checklistItem.update({
    where: { id: itemId },
    data: {
      ...body,
      ...(body.isDone !== undefined ? { completedAt: body.isDone ? new Date() : null } : {}),
    },
    include: { assignee: { select: { id: true, name: true, avatarUrl: true } } },
  });

  res.json({ data: item });
};

export const deleteChecklistItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:update');
  const itemId = String(req.params.itemId);
  const existing = await prisma.checklistItem.findUnique({ where: { id: itemId } });
  if (!existing || existing.taskId !== ref.id) throw notFound('Checklist item not found');
  await prisma.checklistItem.delete({ where: { id: itemId } });
  res.status(204).end();
};

// --- Links -----------------------------------------------------------------

export const addLink = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:update');
  const body = req.body as { targetTaskId: string; type: LinkType };

  const target = await svc.findTaskRef(body.targetTaskId);
  if (target.id === ref.id) throw badRequest('A task cannot be linked to itself');
  await auth.requireProject(target.projectId, 'task:view');

  const link = await prisma.taskLink.upsert({
    where: {
      sourceId_targetId_type: { sourceId: ref.id, targetId: target.id, type: body.type },
    },
    create: { sourceId: ref.id, targetId: target.id, type: body.type },
    update: {},
    include: {
      target: { select: { id: true, key: true, title: true } },
    },
  });

  await logActivity({
    actorId: auth.id,
    action: 'task.linked',
    entityType: 'TASK',
    entityId: ref.id,
    projectId: ref.projectId,
    taskId: ref.id,
    meta: { type: body.type, targetKey: target.key },
  });

  res.status(201).json({ data: link });
};

export const deleteLink = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  await auth.requireProject(ref.projectId, 'task:update');
  const linkId = String(req.params.linkId);

  const link = await prisma.taskLink.findUnique({ where: { id: linkId } });
  if (!link || (link.sourceId !== ref.id && link.targetId !== ref.id)) {
    throw notFound('That link was not found');
  }
  await prisma.taskLink.delete({ where: { id: linkId } });
  res.status(204).end();
};

/** Calendar / timeline feed: tasks with dates, across accessible projects. */
export const getSchedule = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
  const projectId = req.query.projectId ? String(req.query.projectId) : undefined;
  const mine = String(req.query.mine ?? '') === 'true';

  const projectIds = projectId
    ? [(await auth.requireProject(projectId, 'task:view')).projectId]
    : await auth.projectIdsWith('task:view');

  const [tasks, milestones, releases] = await Promise.all([
    prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        ...(mine ? { assignees: { some: { userId: auth.id } } } : {}),
        OR: [
          { dueDate: { gte: from, lte: to } },
          { startDate: { gte: from, lte: to } },
          { AND: [{ startDate: { lte: from } }, { dueDate: { gte: to } }] },
        ],
      },
      select: svc.taskListSelect,
      take: 1000,
    }),
    prisma.milestone.findMany({
      where: { projectId: { in: projectIds }, dueDate: { gte: from, lte: to } },
      select: {
        id: true,
        name: true,
        dueDate: true,
        completedAt: true,
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    }),
    prisma.release.findMany({
      where: {
        projectId: { in: projectIds },
        OR: [{ plannedDate: { gte: from, lte: to } }, { releasedAt: { gte: from, lte: to } }],
      },
      select: {
        id: true,
        version: true,
        name: true,
        status: true,
        plannedDate: true,
        releasedAt: true,
        isHotfix: true,
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    }),
  ]);

  res.json({
    data: {
      tasks: tasks.map(svc.shapeTask),
      milestones,
      releases,
      range: { from, to },
    },
  });
};
