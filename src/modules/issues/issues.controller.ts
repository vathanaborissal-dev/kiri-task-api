import type { Request, Response } from 'express';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { diffFields, logActivity } from '../../services/activity.js';
import { changedFieldNames, shortDescription } from '../../services/notificationCopy.js';
import { notify } from '../../services/notifications.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { IssueStatus } from '../../generated/prisma/enums.js';
import { assertProjectScope, nextIssueKey, nextTaskKey } from '../tasks/tasks.service.js';
import * as svc from './issues.service.js';
import { planTaskSyncForIssueStatus, syncTasksToIssueStatus } from './issueTaskSync.js';
import {
  ISSUE_STATUS_LABEL,
  allowedTransitions,
  refuseTransition,
  transitionTable,
} from './issueWorkflow.js';

/**
 * Turns a refused transition into the right HTTP error.
 *
 * A move that no role may make is a 409 — the issue is in the wrong state, and
 * retrying as somebody else will not help. A move that only wants a permission
 * is a 403.
 */
const assertTransition = (
  from: IssueStatus,
  to: IssueStatus,
  can: (permission: string) => boolean,
) => {
  const refusal = refuseTransition(from, to, can);
  if (!refusal) return;
  throw refusal.code === 'NEEDS_PERMISSION'
    ? forbidden(refusal.message)
    : conflict(refusal.message, { from, to });
};

/** A deadline before the start date is a typo, not a plan. */
const assertDateOrder = (startDate?: Date | null, dueDate?: Date | null) => {
  if (startDate && dueDate && startDate.getTime() > dueDate.getTime()) {
    throw badRequest('The deadline cannot be earlier than the start date', {
      fieldErrors: { dueDate: 'Must be on or after the start date' },
    });
  }
};

const OPEN_STATUSES: IssueStatus[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'READY_FOR_TESTING',
  'REOPENED',
];

type ListQuery = {
  page: number;
  pageSize: number;
  projectId?: string;
  search?: string;
  status?: string[];
  severity?: string[];
  priority?: string[];
  phaseId?: string[];
  assigneeId?: string[];
  reporterId?: string;
  labelId?: string[];
  releaseId?: string;
  unassigned?: boolean;
  overdue?: boolean;
  openOnly: boolean;
  hasTasks?: boolean;
  sort: 'createdAt' | 'updatedAt' | 'severity' | 'priority' | 'dueDate' | 'startDate' | 'status';
  order: 'asc' | 'desc';
  groupBy: 'none' | 'status' | 'severity' | 'assignee' | 'phase';
};

const buildWhere = async (req: Request, query: ListQuery): Promise<Prisma.IssueWhereInput> => {
  const auth = getAuth(req);
  const projectIds = query.projectId
    ? [(await auth.requireProject(query.projectId, 'issue:view')).projectId]
    : await auth.projectIdsWith('issue:view');

  return {
    projectId: { in: projectIds },
    ...(query.status
      ? { status: { in: query.status as IssueStatus[] } }
      : query.openOnly
        ? { status: { in: OPEN_STATUSES } }
        : {}),
    ...(query.severity ? { severity: { in: query.severity as 'MINOR'[] } } : {}),
    ...(query.priority ? { priority: { in: query.priority as 'LOW'[] } } : {}),
    ...(query.phaseId
      ? query.phaseId.includes('none')
        ? { phaseId: null }
        : { phaseId: { in: query.phaseId } }
      : {}),
    ...(query.assigneeId ? { assigneeId: { in: query.assigneeId } } : {}),
    ...(query.unassigned ? { assigneeId: null } : {}),
    ...(query.reporterId ? { reporterId: query.reporterId } : {}),
    ...(query.labelId ? { labels: { some: { labelId: { in: query.labelId } } } } : {}),
    ...(query.releaseId ? { releaseId: query.releaseId } : {}),
    ...(query.overdue ? { dueDate: { lt: new Date() }, status: { in: OPEN_STATUSES } } : {}),
    ...(query.hasTasks === undefined ? {} : query.hasTasks ? { tasks: { some: {} } } : { tasks: { none: {} } }),
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

export const listIssues = async (req: Request, res: Response) => {
  const query = q<ListQuery>(req);
  const where = await buildWhere(req, query);

  const orderBy: Prisma.IssueOrderByWithRelationInput[] =
    query.sort === 'severity'
      ? [{ severity: query.order === 'asc' ? 'asc' : 'desc' }, { createdAt: 'desc' }]
      : query.sort === 'priority'
        ? [{ priority: query.order === 'asc' ? 'asc' : 'desc' }, { createdAt: 'desc' }]
        : query.sort === 'dueDate'
          ? [{ dueDate: { sort: query.order, nulls: 'last' } }]
          : query.sort === 'startDate'
            ? [{ startDate: { sort: query.order, nulls: 'last' } }]
            : query.sort === 'status'
              ? [{ status: query.order }, { createdAt: 'desc' }]
              : query.sort === 'updatedAt'
                ? [{ updatedAt: query.order }]
                : [{ createdAt: query.order }];

  const [issues, total] = await Promise.all([
    prisma.issue.findMany({ where, ...skipTake(query), orderBy, select: svc.issueListSelect }),
    prisma.issue.count({ where }),
  ]);

  const data = issues.map(svc.shapeIssue);

  if (query.groupBy === 'none') {
    res.json(paged(data, total, query));
    return;
  }

  const groups = new Map<string, { key: string; label: string; color?: string; issues: unknown[] }>();
  for (const issue of data) {
    let key = 'none';
    let label = 'None';
    let color: string | undefined;

    if (query.groupBy === 'status') {
      key = issue.status;
      label = svc.STATUS_LABEL[issue.status] ?? issue.status;
    } else if (query.groupBy === 'severity') {
      key = issue.severity;
      label = svc.SEVERITY_LABEL[issue.severity] ?? issue.severity;
    } else if (query.groupBy === 'phase') {
      key = issue.phase?.id ?? 'none';
      label = issue.phase?.name ?? 'No environment';
      color = issue.phase?.color;
    } else if (query.groupBy === 'assignee') {
      key = issue.assignee?.id ?? 'none';
      label = issue.assignee?.name ?? 'Unassigned';
    }

    if (!groups.has(key)) groups.set(key, { key, label, color, issues: [] });
    groups.get(key)!.issues.push(issue);
  }

  res.json({
    data: [...groups.values()],
    meta: { page: query.page, pageSize: query.pageSize, total, grouped: true },
  });
};

export const getIssue = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  await auth.requireProject(ref.projectId, 'issue:view');
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: svc.issueDetailSelect,
  });
  res.json({ data: svc.shapeIssue(issue) });
};

export const createIssue = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    projectId: string;
    title: string;
    description?: string | null;
    stepsToReproduce?: string | null;
    expectedResult?: string | null;
    actualResult?: string | null;
    severity?: 'MAJOR';
    priority?: 'MEDIUM';
    phaseId?: string | null;
    assigneeId?: string | null;
    taskId?: string | null;
    releaseId?: string | null;
    labelIds?: string[];
    startDate?: Date | null;
    dueDate?: Date | null;
  };

  const access = await auth.requireProject(body.projectId, 'issue:create');
  const projectId = access.projectId;

  if (body.assigneeId && !auth.isSuperAdmin && !access.permissions.has('issue:assign')) {
    throw forbidden('You cannot assign issues on this project');
  }

  await assertProjectScope(projectId, {
    phaseId: body.phaseId,
    releaseId: body.releaseId,
    labelIds: body.labelIds,
    ...(body.assigneeId ? { assigneeIds: [body.assigneeId] } : {}),
  });

  if (body.taskId) {
    const task = await prisma.task.findUnique({
      where: { id: body.taskId },
      select: { projectId: true },
    });
    if (task?.projectId !== projectId) throw badRequest('That task is not part of this project');
  }

  assertDateOrder(body.startDate, body.dueDate);

  const issue = await prisma.$transaction(async (tx) => {
    const key = await nextIssueKey(tx, projectId);
    return tx.issue.create({
      data: {
        key,
        projectId,
        title: body.title,
        description: body.description ?? null,
        stepsToReproduce: body.stepsToReproduce ?? null,
        expectedResult: body.expectedResult ?? null,
        actualResult: body.actualResult ?? null,
        ...(body.severity ? { severity: body.severity } : {}),
        ...(body.priority ? { priority: body.priority } : {}),
        phaseId: body.phaseId ?? null,
        assigneeId: body.assigneeId ?? null,
        taskId: body.taskId ?? null,
        releaseId: body.releaseId ?? null,
        reporterId: auth.id,
        status: body.assigneeId ? 'ASSIGNED' : 'OPEN',
        ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
        ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
        ...(body.labelIds?.length
          ? { labels: { create: body.labelIds.map((labelId) => ({ labelId })) } }
          : {}),
        watchers: { create: { userId: auth.id } },
      },
      select: svc.issueDetailSelect,
    });
  });

  // `taskId` names the primary fix; the reverse link is what makes it show up
  // in the issue's task list.
  if (body.taskId) {
    await prisma.task.update({ where: { id: body.taskId }, data: { issueId: issue.id } });
  }

  await logActivity({
    actorId: auth.id,
    action: 'issue.reported',
    entityType: 'ISSUE',
    entityId: issue.id,
    projectId,
    issueId: issue.id,
    meta: { key: issue.key, title: issue.title, severity: issue.severity },
  });

  const url = svc.issueUrl(access.projectKey, issue.key);

  if (body.assigneeId) {
    await notify({
      userIds: [body.assigneeId],
      event: 'ISSUE_ASSIGNED',
      title: `${issue.key}: ${issue.title}`,
      body: [
        `Assigned by: ${auth.user.name}`,
        `Severity: ${svc.SEVERITY_LABEL[issue.severity]}`,
        `Description: ${shortDescription(issue.description)}`,
      ].join('\n'),
      url,
      actorId: auth.id,
      projectId,
      issueId: issue.id,
      telegramButtons: [[{ text: '▶️ Start working', callbackData: `issue:start:${issue.id}` }]],
    });
  }

  // Severe issues reach everyone who can act on them, even when unassigned;
  // ordinary ones just go to the project owner.
  const escalate = issue.severity === 'CRITICAL' || issue.severity === 'BLOCKER';
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { ownerId: true },
  });
  const audience = escalate
    ? await svc.projectEscalationAudience(projectId)
    : [project.ownerId];

  await notify({
    userIds: audience.filter((id) => id !== body.assigneeId),
    event: 'ISSUE_REPORTED',
    title: `${escalate ? '🚨 ' : ''}${issue.key} reported${issue.phase ? ` in ${issue.phase.name}` : ''}`,
    body: `${auth.user.name} reported “${issue.title}” (${svc.SEVERITY_LABEL[issue.severity]}).`,
    url,
    actorId: auth.id,
    projectId,
    issueId: issue.id,
  });

  res.status(201).json({ data: svc.shapeIssue(issue) });
};

export const updateIssue = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  const access = await auth.requireProject(ref.projectId, 'issue:view');
  const body = req.body as Record<string, unknown>;

  const before = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      title: true,
      description: true,
      stepsToReproduce: true,
      expectedResult: true,
      actualResult: true,
      severity: true,
      priority: true,
      status: true,
      phaseId: true,
      assigneeId: true,
      taskId: true,
      releaseId: true,
      startDate: true,
      dueDate: true,
      reopenCount: true,
    },
  });

  const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);
  const touchesStatus = body.status !== undefined && body.status !== before.status;
  const touchesAssignee = body.assigneeId !== undefined && body.assigneeId !== before.assigneeId;
  const touchesOther = Object.keys(body).some((k) => !['status', 'assigneeId'].includes(k));

  if (touchesStatus && !can('issue:change_status')) throw forbidden('You cannot change issue status');
  if (touchesAssignee && !can('issue:assign')) throw forbidden('You cannot assign issues');
  if (touchesOther && !can('issue:update')) throw forbidden('You cannot edit this issue');

  // The workflow table decides whether this particular move is legal, and
  // whether this actor's role may make it.
  if (touchesStatus) assertTransition(before.status, body.status as IssueStatus, can);

  assertDateOrder(
    (body.startDate as Date | null | undefined) ?? before.startDate,
    (body.dueDate as Date | null | undefined) ?? before.dueDate,
  );

  await assertProjectScope(ref.projectId, {
    phaseId: body.phaseId as string | null | undefined,
    releaseId: body.releaseId as string | null | undefined,
    labelIds: body.labelIds as string[] | undefined,
    ...(body.assigneeId ? { assigneeIds: [String(body.assigneeId)] } : {}),
  });

  const { labelIds, ...scalars } = body as { labelIds?: string[] } & Record<string, unknown>;

  const statusSideEffects: Record<string, unknown> = {};
  if (touchesStatus) {
    const next = body.status as IssueStatus;
    statusSideEffects.resolvedAt = next === 'RESOLVED' ? new Date() : null;
    statusSideEffects.closedAt = next === 'CLOSED' || next === 'WONT_FIX' ? new Date() : null;
    if (next === 'REOPENED') statusSideEffects.reopenCount = before.reopenCount + 1;
  }
  // Assigning an untouched issue moves it to Assigned — unless the same
  // request named a status, which is the more specific instruction. Without the
  // guard, `{ status: 'IN_PROGRESS', assigneeId: x }` on an open issue landed
  // in Assigned and silently dropped the status the caller asked for.
  if (!touchesStatus && touchesAssignee && body.assigneeId && before.status === 'OPEN') {
    statusSideEffects.status = 'ASSIGNED';
  }

  // Worked out before the transaction opens, so it costs the transaction one
  // statement rather than three round trips.
  const taskSyncPlan = touchesStatus
    ? await planTaskSyncForIssueStatus(ref.id, body.status as IssueStatus)
    : null;

  const issue = await prisma.$transaction(async (tx) => {
    if (labelIds) {
      await tx.issueLabel.deleteMany({ where: { issueId: ref.id } });
      if (labelIds.length) {
        await tx.issueLabel.createMany({
          data: labelIds.map((labelId) => ({ issueId: ref.id, labelId })),
        });
      }
    }
    if (touchesAssignee && body.assigneeId) {
      await tx.issueWatcher.createMany({
        data: [{ issueId: ref.id, userId: String(body.assigneeId) }],
        skipDuplicates: true,
      });
    }
    if (body.taskId && body.taskId !== before.taskId) {
      await tx.task.update({ where: { id: String(body.taskId) }, data: { issueId: ref.id } });
    }
    await syncTasksToIssueStatus(tx, ref.id, taskSyncPlan);
    return tx.issue.update({
      where: { id: ref.id },
      data: { ...scalars, ...statusSideEffects },
      select: svc.issueDetailSelect,
    });
  });

  const changes = diffFields(before as Record<string, unknown>, scalars, [
    'title',
    'description',
    'stepsToReproduce',
    'expectedResult',
    'actualResult',
    'severity',
    'priority',
    'status',
    'phaseId',
    'assigneeId',
    'taskId',
    'releaseId',
    'startDate',
    'dueDate',
  ]);

  if (Object.keys(changes).length || labelIds) {
    await logActivity({
      actorId: auth.id,
      action: touchesStatus
        ? body.status === 'REOPENED'
          ? 'issue.reopened'
          : 'issue.status_changed'
        : 'issue.updated',
      entityType: 'ISSUE',
      entityId: ref.id,
      projectId: ref.projectId,
      issueId: ref.id,
      meta: { changes, ...(touchesStatus ? { statusFrom: before.status, statusTo: issue.status } : {}) },
    });
  }

  const url = svc.issueUrl(access.projectKey, issue.key);
  const audience = await svc.issueAudience(ref.id);

  if (touchesStatus) {
    await notify({
      userIds: audience,
      event: 'ISSUE_STATUS_CHANGED',
      title: `${issue.key} → ${svc.STATUS_LABEL[issue.status]}`,
      body: `${auth.user.name} moved “${issue.title}” from ${svc.STATUS_LABEL[before.status]} to ${svc.STATUS_LABEL[issue.status]}.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      issueId: ref.id,
    });
  }

  const editedFields = [
    ...Object.keys(changes).filter((field) => field !== 'status' && field !== 'assigneeId'),
    ...(labelIds ? ['labelIds'] : []),
  ];
  const currentAssigneeId = issue.assignee?.id;
  const newlyAssignedId = touchesAssignee && body.assigneeId ? String(body.assigneeId) : null;
  if (editedFields.length > 0 && currentAssigneeId && currentAssigneeId !== newlyAssignedId) {
    await notify({
      userIds: [currentAssigneeId],
      event: 'ISSUE_UPDATED',
      title: `${issue.key} was updated`,
      body: [
        `Updated by: ${auth.user.name}`,
        `Changed: ${changedFieldNames(editedFields)}`,
        `Description: ${shortDescription(issue.description)}`,
      ].join('\n'),
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      issueId: ref.id,
    });
  }

  if (touchesAssignee && body.assigneeId) {
    await notify({
      userIds: [String(body.assigneeId)],
      event: 'ISSUE_ASSIGNED',
      title: `${issue.key}: ${issue.title}`,
      body: [
        `Assigned by: ${auth.user.name}`,
        `Severity: ${svc.SEVERITY_LABEL[issue.severity]}`,
        `Description: ${shortDescription(issue.description)}`,
      ].join('\n'),
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      issueId: ref.id,
      telegramButtons: [[{ text: '▶️ Start working', callbackData: `issue:start:${issue.id}` }]],
    });
  }

  if (touchesAssignee && before.assigneeId) {
    await notify({
      userIds: [before.assigneeId],
      event: 'ISSUE_UPDATED',
      title: `You were removed from ${issue.key}`,
      body: `${auth.user.name} removed you from “${issue.title}”.`,
      url,
      actorId: auth.id,
      projectId: ref.projectId,
      issueId: ref.id,
    });
  }

  res.json({ data: svc.shapeIssue(issue) });
};

/** Dedicated status endpoint so the UI can move an issue in one click. */
export const changeStatus = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  const access = await auth.requireProject(ref.projectId, 'issue:change_status');
  const body = req.body as { status: IssueStatus; comment?: string };

  const before = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: { status: true, title: true, key: true, reopenCount: true },
  });
  if (before.status === body.status) {
    res.json({ data: null, unchanged: true });
    return;
  }

  assertTransition(before.status, body.status, (permission) =>
    auth.isSuperAdmin || access.permissions.has(permission),
  );

  const taskSyncPlan = await planTaskSyncForIssueStatus(ref.id, body.status);

  const issue = await prisma.$transaction(async (tx) => {
    if (body.comment) {
      await tx.comment.create({
        data: {
          body: body.comment,
          entityType: 'ISSUE',
          authorId: auth.id,
          issueId: ref.id,
          projectId: ref.projectId,
        },
      });
    }
    await syncTasksToIssueStatus(tx, ref.id, taskSyncPlan);
    return tx.issue.update({
      where: { id: ref.id },
      data: {
        status: body.status,
        resolvedAt: body.status === 'RESOLVED' ? new Date() : null,
        closedAt: body.status === 'CLOSED' || body.status === 'WONT_FIX' ? new Date() : null,
        ...(body.status === 'REOPENED' ? { reopenCount: before.reopenCount + 1 } : {}),
      },
      select: svc.issueDetailSelect,
    });
  });

  await logActivity({
    actorId: auth.id,
    action: body.status === 'REOPENED' ? 'issue.reopened' : 'issue.status_changed',
    entityType: 'ISSUE',
    entityId: ref.id,
    projectId: ref.projectId,
    issueId: ref.id,
    meta: { statusFrom: before.status, statusTo: body.status, comment: body.comment ?? null },
  });

  await notify({
    userIds: await svc.issueAudience(ref.id),
    event: 'ISSUE_STATUS_CHANGED',
    title: `${issue.key} → ${svc.STATUS_LABEL[issue.status]}`,
    body: `${auth.user.name} moved “${issue.title}” to ${svc.STATUS_LABEL[issue.status]}.${body.comment ? ` “${body.comment}”` : ''}`,
    url: svc.issueUrl(access.projectKey, issue.key),
    actorId: auth.id,
    projectId: ref.projectId,
    issueId: ref.id,
  });

  res.json({ data: svc.shapeIssue(issue) });
};

export const deleteIssue = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  const access = await auth.requireProject(ref.projectId, 'issue:delete');
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: { key: true, title: true, description: true, assigneeId: true },
  });
  await prisma.issue.delete({ where: { id: ref.id } });
  await logActivity({
    actorId: auth.id,
    action: 'issue.deleted',
    entityType: 'ISSUE',
    entityId: ref.id,
    projectId: ref.projectId,
    meta: issue,
  });
  await notify({
    userIds: issue.assigneeId ? [issue.assigneeId] : [],
    event: 'ISSUE_DELETED',
    title: `${issue.key} was deleted`,
    body: [
      `Deleted by: ${auth.user.name}`,
      `Title: ${issue.title}`,
      `Description: ${shortDescription(issue.description)}`,
    ].join('\n'),
    url: `/projects/${access.projectKey}/issues`,
    actorId: auth.id,
    projectId: ref.projectId,
  });
  res.status(204).end();
};

export const toggleWatch = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  await auth.requireProject(ref.projectId, 'issue:view');

  const existing = await prisma.issueWatcher.findUnique({
    where: { issueId_userId: { issueId: ref.id, userId: auth.id } },
  });
  if (existing) {
    await prisma.issueWatcher.delete({
      where: { issueId_userId: { issueId: ref.id, userId: auth.id } },
    });
    res.json({ watching: false });
    return;
  }
  await prisma.issueWatcher.create({ data: { issueId: ref.id, userId: auth.id } });
  res.json({ watching: true });
};

/**
 * Raises a task to work on this issue.
 *
 * An issue can have as many tasks as the work needs — "write the migration",
 * "fix the handler", "add the regression test" — so this no longer refuses once
 * a task exists. The first task also becomes the issue's primary `task`, which
 * is what the single-link UI and the Telegram cards still read.
 */
export const convertToTask = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  const access = await auth.requireProject(ref.projectId, 'task:create');

  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      key: true,
      title: true,
      description: true,
      severity: true,
      priority: true,
      phaseId: true,
      assigneeId: true,
      taskId: true,
      startDate: true,
      dueDate: true,
    },
  });

  const status = await prisma.taskStatus.findFirst({
    where: { projectId: ref.projectId, isDefault: true },
    select: { id: true },
  });
  const fallback = await prisma.taskStatus.findFirstOrThrow({
    where: { projectId: ref.projectId },
    orderBy: { order: 'asc' },
    select: { id: true },
  });

  const body = (req.body ?? {}) as {
    title?: string;
    assigneeIds?: string[];
    startDate?: string | null;
    dueDate?: string | null;
  };

  const assigneeIds = body.assigneeIds?.length
    ? body.assigneeIds
    : issue.assigneeId
      ? [issue.assigneeId]
      : [];

  if (assigneeIds.length && !auth.isSuperAdmin && !access.permissions.has('task:assign')) {
    const onlySelf = assigneeIds.every((id) => id === auth.id);
    if (!onlySelf) throw forbidden('You can only assign work to yourself on this project');
  }
  await assertProjectScope(ref.projectId, { assigneeIds });

  const title = body.title?.trim()
    ? body.title.trim().slice(0, 300)
    : issue.taskId
      ? `${issue.key}: follow-up`
      : `Fix ${issue.key}: ${issue.title}`;

  const task = await prisma.$transaction(async (tx) => {
    const key = await nextTaskKey(tx, ref.projectId);
    const created = await tx.task.create({
      data: {
        key,
        projectId: ref.projectId,
        title,
        description: issue.taskId ? null : issue.description,
        type: 'BUG',
        priority: issue.priority,
        statusId: status?.id ?? fallback.id,
        phaseId: issue.phaseId,
        qaStatus: 'PENDING',
        reporterId: auth.id,
        issueId: ref.id,
        startDate: body.startDate ? new Date(body.startDate) : issue.startDate,
        dueDate: body.dueDate ? new Date(body.dueDate) : issue.dueDate,
        ...(assigneeIds.length
          ? { assignees: { create: assigneeIds.map((userId) => ({ userId })) } }
          : {}),
        watchers: { create: { userId: auth.id } },
      },
      select: { id: true, key: true, title: true },
    });
    // The primary link is set once and left alone, so "fix in KIRI-12" keeps
    // pointing at the task people already know about.
    if (!issue.taskId) {
      await tx.issue.update({ where: { id: ref.id }, data: { taskId: created.id } });
    }
    return created;
  });

  await logActivity({
    actorId: auth.id,
    action: 'issue.task_created',
    entityType: 'ISSUE',
    entityId: ref.id,
    projectId: ref.projectId,
    issueId: ref.id,
    taskId: task.id,
    meta: { taskKey: task.key, issueKey: issue.key },
  });

  if (assigneeIds.length) {
    await notify({
      userIds: assigneeIds,
      event: 'TASK_ASSIGNED',
      title: `${task.key}: ${task.title}`,
      body: [
        `Assigned by: ${auth.user.name}`,
        `Fixes: ${issue.key} — ${issue.title}`,
        `Description: ${shortDescription(issue.description)}`,
      ].join('\n'),
      url: `/projects/${access.projectKey}/tasks/${task.key}`,
      actorId: auth.id,
      projectId: ref.projectId,
      taskId: task.id,
      telegramButtons: [
        [
          { text: '▶️ Start', callbackData: `task:start:${task.id}` },
          { text: '✅ Done', callbackData: `task:done:${task.id}` },
        ],
      ],
    });
  }

  res.status(201).json({ data: task, url: `/projects/${access.projectKey}/tasks/${task.key}` });
};

// --- Workflow -------------------------------------------------------------

/** The whole status table, so the UI can show who may make which move. */
export const getWorkflow = async (_req: Request, res: Response) => {
  res.json({ data: transitionTable() });
};

/** The moves this viewer can make on this issue right now. */
export const getTransitions = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await svc.findIssueRef(String(req.params.issueId));
  const access = await auth.requireProject(ref.projectId, 'issue:view');
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { id: ref.id },
    select: { status: true },
  });

  const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);
  const allowed = can('issue:change_status') ? allowedTransitions(issue.status, can) : [];

  res.json({
    data: {
      status: issue.status,
      allowed,
      blocked: (Object.keys(ISSUE_STATUS_LABEL) as IssueStatus[])
        .filter((status) => status !== issue.status && !allowed.includes(status))
        .map((status) => ({
          status,
          reason: refuseTransition(issue.status, status, can)?.message ?? null,
        })),
    },
  });
};

/** Changes one field across many issues at once. */
export const bulkUpdate = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    issueIds: string[];
    status?: IssueStatus;
    severity?: 'MAJOR';
    priority?: 'MEDIUM';
    phaseId?: string | null;
    assigneeId?: string | null;
    startDate?: Date | null;
    dueDate?: Date | null;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  };

  const issues = await prisma.issue.findMany({
    where: { id: { in: body.issueIds } },
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      projectId: true,
      reopenCount: true,
      startDate: true,
      dueDate: true,
      project: { select: { key: true } },
    },
  });
  if (issues.length === 0) throw notFound('No matching issues');

  const projectIds = [...new Set(issues.map((issue) => issue.projectId))];
  const permissionsByProject = new Map<string, (permission: string) => boolean>();

  for (const projectId of projectIds) {
    const access = await auth.requireProject(projectId, 'issue:view');
    const can = (permission: string) => auth.isSuperAdmin || access.permissions.has(permission);
    permissionsByProject.set(projectId, can);

    const touchesOther = Object.keys(body).some(
      (key) => !['issueIds', 'status', 'assigneeId'].includes(key),
    );
    if (body.status !== undefined && !can('issue:change_status')) {
      throw forbidden('You cannot change issue status on one of these projects');
    }
    if (body.assigneeId !== undefined && !can('issue:assign')) {
      throw forbidden('You cannot assign issues on one of these projects');
    }
    if (touchesOther && !can('issue:update')) {
      throw forbidden('You cannot edit issues on one of these projects');
    }
  }

  if (projectIds.length > 1 && (body.phaseId !== undefined || body.assigneeId !== undefined)) {
    throw badRequest(
      'Environments and people are project-specific — bulk edit one project at a time',
    );
  }

  // Everything is checked before anything is written: a bulk edit that moved
  // half the list and then refused would be worse than one that refused.
  if (body.status !== undefined) {
    for (const issue of issues) {
      if (issue.status === body.status) continue;
      assertTransition(issue.status, body.status, permissionsByProject.get(issue.projectId)!);
    }
  }
  for (const issue of issues) {
    assertDateOrder(
      body.startDate !== undefined ? body.startDate : issue.startDate,
      body.dueDate !== undefined ? body.dueDate : issue.dueDate,
    );
  }

  if (projectIds[0]) {
    await assertProjectScope(projectIds[0], {
      phaseId: body.phaseId,
      labelIds: [...(body.addLabelIds ?? []), ...(body.removeLabelIds ?? [])],
      ...(body.assigneeId ? { assigneeIds: [body.assigneeId] } : {}),
    });
  }

  const scalars: Record<string, unknown> = {};
  if (body.severity) scalars.severity = body.severity;
  if (body.priority) scalars.priority = body.priority;
  if (body.phaseId !== undefined) scalars.phaseId = body.phaseId;
  if (body.assigneeId !== undefined) scalars.assigneeId = body.assigneeId;
  if (body.startDate !== undefined) scalars.startDate = body.startDate;
  if (body.dueDate !== undefined) scalars.dueDate = body.dueDate;

  const ids = issues.map((issue) => issue.id);
  const moved = body.status !== undefined ? issues.filter((i) => i.status !== body.status) : [];

  // Planned up front, so the transaction only ever writes.
  const taskSyncPlans = new Map<string, { statusId: string } | null>();
  for (const issue of moved) {
    taskSyncPlans.set(issue.id, await planTaskSyncForIssueStatus(issue.id, body.status!));
  }

  await prisma.$transaction(async (tx) => {
    if (Object.keys(scalars).length) {
      await tx.issue.updateMany({ where: { id: { in: ids } }, data: scalars });
    }
    if (body.status !== undefined && moved.length) {
      const next = body.status;
      // `reopenCount` is per-issue, so a reopen cannot be one updateMany.
      for (const issue of moved) {
        await syncTasksToIssueStatus(tx, issue.id, taskSyncPlans.get(issue.id) ?? null);
        await tx.issue.update({
          where: { id: issue.id },
          data: {
            status: next,
            resolvedAt: next === 'RESOLVED' ? new Date() : null,
            closedAt: next === 'CLOSED' || next === 'WONT_FIX' ? new Date() : null,
            ...(next === 'REOPENED' ? { reopenCount: issue.reopenCount + 1 } : {}),
          },
        });
      }
    }
    if (body.assigneeId) {
      await tx.issueWatcher.createMany({
        data: ids.map((issueId) => ({ issueId, userId: body.assigneeId! })),
        skipDuplicates: true,
      });
    }
    if (body.removeLabelIds?.length) {
      await tx.issueLabel.deleteMany({
        where: { issueId: { in: ids }, labelId: { in: body.removeLabelIds } },
      });
    }
    if (body.addLabelIds?.length) {
      await tx.issueLabel.createMany({
        data: ids.flatMap((issueId) => body.addLabelIds!.map((labelId) => ({ issueId, labelId }))),
        skipDuplicates: true,
      });
    }
  });

  const editedFields = Object.keys(body).filter((field) => field !== 'issueIds');

  await logActivity({
    actorId: auth.id,
    action: 'issue.bulk_updated',
    entityType: 'ISSUE',
    entityId: ids[0]!,
    projectId: projectIds[0]!,
    meta: { count: ids.length, fields: editedFields },
  });

  for (const issue of issues) {
    const url = svc.issueUrl(issue.project.key, issue.key);
    const audience = await svc.issueAudience(issue.id);
    const wasMoved = moved.some((entry) => entry.id === issue.id);

    if (wasMoved) {
      await notify({
        userIds: audience,
        event: 'ISSUE_STATUS_CHANGED',
        title: `${issue.key} → ${ISSUE_STATUS_LABEL[body.status!]}`,
        body: `${auth.user.name} moved “${issue.title}” from ${ISSUE_STATUS_LABEL[issue.status]} to ${ISSUE_STATUS_LABEL[body.status!]}.`,
        url,
        actorId: auth.id,
        projectId: issue.projectId,
        issueId: issue.id,
      });
    }

    const otherFields = editedFields.filter((field) => field !== 'status');
    if (otherFields.length > 0) {
      await notify({
        userIds: audience,
        event: 'ISSUE_UPDATED',
        title: `${issue.key} was updated`,
        body: [
          `Updated by: ${auth.user.name}`,
          `Changed: ${changedFieldNames(otherFields)}`,
        ].join('\n'),
        url,
        actorId: auth.id,
        projectId: issue.projectId,
        issueId: issue.id,
      });
    }
  }

  res.json({ updated: ids.length, moved: moved.length });
};
