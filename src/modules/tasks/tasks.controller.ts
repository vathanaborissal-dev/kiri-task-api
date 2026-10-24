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
import {
  advanceIssueFromTasks,
  assertTaskStatusAllowedByIssue,
  assertTasksStatusAllowedByIssue,
} from '../issues/issueTaskSync.js';
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
  issueId?: string;
  topLevelOnly: boolean;
  unassigned?: boolean;
  overdue?: boolean;
  dueFrom?: Date | null;
  dueTo?: Date | null;
  dueWithinDays?: number;
  includeDone: boolean;
  sort: 'position' | 'dueDate' | 'priority' | 'progress' | 'createdAt' | 'updatedAt' | 'title' | 'key';
  order: 'asc' | 'desc';
  groupBy: 'none' | 'status' | 'assignee' | 'priority' | 'phase' | 'milestone';
};

const PRIORITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** A deadline before the start date is a typo, not a plan. */
const assertDateOrder = (startDate?: Date | null, dueDate?: Date | null) => {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw badRequest('The deadline cannot be earlier than the start date', {
      fieldErrors: { dueDate: 'Must be on or after the start date' },
    });
  }
};

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
    ...(query.issueId ? { issueId: query.issueId } : {}),
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
    case 'progress':
      return [{ progress: query.order }, { dueDate: 'asc' }];
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
    progress?: number;
    issueId?: string | null;
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
  assertDateOrder(body.startDate, body.dueDate);

  await svc.assertProjectScope(projectId, body);

  if (body.issueId) {
    const issue = await prisma.issue.findUnique({
      where: { id: body.issueId },
      select: { projectId: true },
    });
    if (issue?.projectId !== projectId) {
      throw badRequest('That issue is not part of this project');
    }
  }

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
        ...(body.progress !== undefined ? { progress: body.progress } : {}),
        issueId: body.issueId ?? null,
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
      progress: true,
      issueId: true,
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
  const touchesProgress = body.progress !== undefined && body.progress !== before.progress;
  const touchesOther = Object.keys(body).some(
    (k) =>
      ![
        'statusId',
        'phaseId',
        'qaStatus',
        'dueDate',
        'startDate',
        'assigneeIds',
        'progress',
      ].includes(k),
  );

  // Whoever is doing the work reports how far along it is. Requiring
  // `task:update` for that would mean a developer could move the card but not
  // say it is 60% done, which is the one number their lead actually reads.
  const isAssignee = before.assignees.some((assignee) => assignee.userId === auth.id);

  if (touchesStatus && !can('task:change_status')) throw forbidden('You cannot change task status');
  if (touchesPhase && !can('task:manage_phase')) throw forbidden('You cannot change the phase');
  if (touchesQa && !can('task:manage_qa')) throw forbidden('You cannot change the testing status');
  if (touchesDates && !can('task:manage_deadline')) throw forbidden('You cannot change deadlines');
  if (touchesOther && !can('task:update')) throw forbidden('You cannot edit this task');
  if (touchesProgress && !can('task:update') && !isAssignee) {
    throw forbidden('Only the people working on this task can update its progress');
  }
  if (touchesAssignees) {
    const next = body.assigneeIds as string[];
    const onlySelf =
      next.length <= 1 && next.every((id) => id === auth.id) &&
      before.assignees.every((a) => a.userId === auth.id);
    // Pulling somebody in to help is open to whoever is already on the task;
    // dropping a colleague off it is not.
    const addsOnly =
      isAssignee && before.assignees.every((assignee) => next.includes(assignee.userId));
    if (!can('task:assign') && !onlySelf && !addsOnly) {
      throw forbidden('You can add people to help, but only a lead can take someone off this task');
    }
  }

  assertDateOrder(
    (body.startDate as Date | null | undefined) ?? before.startDate,
    (body.dueDate as Date | null | undefined) ?? before.dueDate,
  );

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
  let progress: number | undefined;
  if (touchesStatus) {
    const nextStatus = await prisma.taskStatus.findUniqueOrThrow({
      where: { id: String(body.statusId) },
      select: { category: true, name: true },
    });
    // A task that fixes an issue cannot be restarted while that issue is
    // settled — the issue has to be reopened first.
    await assertTaskStatusAllowedByIssue(ref.id, nextStatus.category);
    completedAt = nextStatus.category === 'DONE' ? new Date() : null;
    progress = svc.progressForStatus(
      nextStatus.category,
      body.progress as number | undefined,
      before.progress,
    );
  } else if (touchesProgress) {
    // No status change, so reconcile against the column the task is already in
    // — otherwise a progress-only PATCH could set 100% on a task in Backlog.
    const current = await prisma.taskStatus.findUniqueOrThrow({
      where: { id: before.statusId },
      select: { category: true },
    });
    progress = svc.progressForStatus(
      current.category,
      body.progress as number,
      before.progress,
    );
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
      data: {
        ...scalars,
        ...(completedAt !== undefined ? { completedAt } : {}),
        ...(progress !== undefined ? { progress } : {}),
      },
      select: svc.taskDetailSelect,
    });
  });

  // The issue follows its tasks: the first one to start moves it to In
  // Progress, the last one to finish moves it to Ready for Testing.
  const issueMoved =
    touchesStatus && before.issueId
      ? await advanceIssueFromTasks(ref.id, { id: auth.id, name: auth.user.name })
      : null;

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
    'progress',
    'issueId',
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

  res.json({ data: svc.shapeTask(task), ...(issueMoved ? { issue: issueMoved } : {}) });
};

export const moveTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:change_status');
  const body = req.body as { statusId: string; afterTaskId?: string | null };

  await svc.assertProjectScope(ref.projectId, { statusId: body.statusId });

  const before = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      statusId: true,
      title: true,
      key: true,
      progress: true,
      issueId: true,
      status: { select: { name: true } },
    },
  });

  const position = await svc.positionAfter(ref.projectId, body.statusId, body.afterTaskId);
  const nextStatus = await prisma.taskStatus.findUniqueOrThrow({
    where: { id: body.statusId },
    select: { category: true, name: true },
  });

  // Dragging a card is the most common way a status changes, so the issue gate
  // has to live here too — not just on the detail form.
  if (before.statusId !== body.statusId) {
    await assertTaskStatusAllowedByIssue(ref.id, nextStatus.category);
  }
  const progress = svc.progressForStatus(nextStatus.category, undefined, before.progress);

  const task = await prisma.task.update({
    where: { id: ref.id },
    data: {
      statusId: body.statusId,
      position,
      completedAt: nextStatus.category === 'DONE' ? new Date() : null,
      ...(progress !== undefined ? { progress } : {}),
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

  const issueMoved =
    before.statusId !== body.statusId && before.issueId
      ? await advanceIssueFromTasks(ref.id, { id: auth.id, name: auth.user.name })
      : null;

  res.json({ data: svc.shapeTask(task), ...(issueMoved ? { issue: issueMoved } : {}) });
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
    startDate?: Date | null;
    dueDate?: Date | null;
    progress?: number;
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
      progress: true,
      issueId: true,
      startDate: true,
      dueDate: true,
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
    if (
      (body.dueDate !== undefined || body.startDate !== undefined) &&
      !auth.isSuperAdmin &&
      !access.permissions.has('task:manage_deadline')
    ) {
      throw forbidden('You cannot change deadlines on one of these projects');
    }
    if (
      body.progress !== undefined &&
      !auth.isSuperAdmin &&
      !access.permissions.has('task:update')
    ) {
      throw forbidden('You cannot update progress on one of these projects');
    }
  }

  for (const task of tasks) {
    assertDateOrder(
      body.startDate !== undefined ? body.startDate : task.startDate,
      body.dueDate !== undefined ? body.dueDate : task.dueDate,
    );
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
  if (body.startDate !== undefined) scalars.startDate = body.startDate;
  if (body.dueDate !== undefined) scalars.dueDate = body.dueDate;
  if (body.progress !== undefined) scalars.progress = body.progress;

  if (Object.keys(scalars).length) {
    await svc.assertProjectScope(projectIds[0]!, {
      statusId: body.statusId,
      phaseId: body.phaseId,
      milestoneId: body.milestoneId,
      releaseId: body.releaseId,
    });
  }

  const ids = tasks.map((t) => t.id);

  // One status for the whole selection, so the category — and therefore the
  // issue gate and the percentage — is worked out once.
  if (body.statusId) {
    const nextStatus = await prisma.taskStatus.findUniqueOrThrow({
      where: { id: body.statusId },
      select: { category: true },
    });
    await assertTasksStatusAllowedByIssue(ids, nextStatus.category);
    scalars.completedAt = nextStatus.category === 'DONE' ? new Date() : null;
    if (nextStatus.category === 'DONE') {
      scalars.progress = 100;
    } else if (body.progress !== undefined) {
      scalars.progress = Math.min(body.progress, 99);
    }
  }

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

  // One pass per affected issue, not per task: `advanceIssueFromTasks` reads
  // every task of the issue, so calling it twice for the same issue would be
  // the same query and the same answer.
  if (body.statusId) {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (!task.issueId || seen.has(task.issueId)) continue;
      seen.add(task.issueId);
      await advanceIssueFromTasks(task.id, { id: auth.id, name: auth.user.name });
    }
  }

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

/**
 * Pulls another developer onto a task to help.
 *
 * Additive and deliberately low-friction: anyone already on the task can call
 * for help without needing `task:assign`, because needing a lead's attention to
 * get a second pair of hands is exactly what stops people asking.
 */
export const addHelper = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:view');
  const body = req.body as { userId: string; note?: string };

  const task = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      key: true,
      title: true,
      description: true,
      assignees: { select: { userId: true } },
    },
  });

  const isAssignee = task.assignees.some((assignee) => assignee.userId === auth.id);
  const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);
  if (!isAssignee && !can('task:assign')) {
    throw forbidden('Only someone working on this task, or a lead, can ask for help');
  }

  if (task.assignees.some((assignee) => assignee.userId === body.userId)) {
    throw badRequest('They are already working on this task');
  }

  await svc.assertProjectScope(ref.projectId, { assigneeIds: [body.userId] });

  await prisma.$transaction(async (tx) => {
    await tx.taskAssignee.create({ data: { taskId: ref.id, userId: body.userId } });
    await tx.taskWatcher.createMany({
      data: [{ taskId: ref.id, userId: body.userId }],
      skipDuplicates: true,
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'task.helper_added',
    entityType: 'TASK',
    entityId: ref.id,
    projectId: ref.projectId,
    taskId: ref.id,
    meta: { userId: body.userId, note: body.note ?? null },
  });

  const url = svc.taskUrl(access.projectKey, task.key);

  await notify({
    userIds: [body.userId],
    event: 'TASK_ASSIGNED',
    title: `${auth.user.name} asked for your help on ${task.key}`,
    body: [
      `Task: ${task.title}`,
      ...(body.note ? [`Note: ${body.note}`] : []),
      `Description: ${shortDescription(task.description)}`,
    ].join('\n'),
    url,
    actorId: auth.id,
    projectId: ref.projectId,
    taskId: ref.id,
    telegramButtons: [
      [
        { text: '▶️ Start', callbackData: `task:start:${ref.id}` },
        { text: '✅ Done', callbackData: `task:done:${ref.id}` },
      ],
    ],
  });

  // Everybody else on the task should know who just joined.
  await notify({
    userIds: task.assignees.map((assignee) => assignee.userId).filter((id) => id !== auth.id),
    event: 'TASK_UPDATED',
    title: `${task.key} picked up another pair of hands`,
    body: `${auth.user.name} asked for help on “${task.title}”.`,
    url,
    actorId: auth.id,
    projectId: ref.projectId,
    taskId: ref.id,
  });

  const updated = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: svc.taskDetailSelect,
  });
  res.status(201).json({ data: svc.shapeTask(updated) });
};

/** Takes a helper back off a task. A lead's call, or your own. */
export const removeHelper = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findTaskRef(String(req.params.taskId));
  const access = await auth.requireProject(ref.projectId, 'task:view');
  const userId = String(req.params.userId);

  const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);
  if (userId !== auth.id && !can('task:assign')) {
    throw forbidden('Only a lead can take somebody else off a task');
  }

  const existing = await prisma.taskAssignee.findUnique({
    where: { taskId_userId: { taskId: ref.id, userId } },
  });
  if (!existing) throw notFound('They are not on this task');

  await prisma.taskAssignee.delete({ where: { taskId_userId: { taskId: ref.id, userId } } });

  await logActivity({
    actorId: auth.id,
    action: 'task.helper_removed',
    entityType: 'TASK',
    entityId: ref.id,
    projectId: ref.projectId,
    taskId: ref.id,
    meta: { userId },
  });

  if (userId !== auth.id) {
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: ref.id },
      select: { key: true, title: true },
    });
    await notify({
      userIds: [userId],
      event: 'TASK_UNASSIGNED',
      title: `You were removed from ${task.key}`,
      body: `${auth.user.name} took you off “${task.title}”.`,
      url: svc.taskUrl(access.projectKey, task.key),
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: ref.id,
    });
  }

  const updated = await prisma.task.findUniqueOrThrow({
    where: { id: ref.id },
    select: svc.taskDetailSelect,
  });
  res.json({ data: svc.shapeTask(updated) });
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
