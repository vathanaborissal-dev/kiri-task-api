import { uploadRemoteUrl } from '../lib/cloudinary.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import { logActivity } from '../services/activity.js';
import type { AuthContext } from '../services/authContext.js';
import { notify } from '../services/notifications.js';
import type { IssueStatus, Severity, StatusCategory } from '../generated/prisma/enums.js';
import { nextIssueKey } from '../modules/tasks/tasks.service.js';
import { STATUS_LABEL } from '../modules/issues/issues.service.js';

/**
 * Bot-side write operations.
 *
 * These go through the same AuthContext permission checks as the HTTP API and
 * write the same activity log and notifications, so a change made in Telegram
 * is indistinguishable from one made on the website.
 */

export const moveTaskToCategory = async (
  auth: AuthContext,
  taskId: string,
  category: StatusCategory,
) => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      key: true,
      title: true,
      projectId: true,
      statusId: true,
      status: { select: { name: true, category: true } },
      project: { select: { key: true } },
      reporterId: true,
      assignees: { select: { userId: true } },
      watchers: { select: { userId: true } },
    },
  });
  if (!task) throw notFound('Task not found');

  await auth.requireProject(task.projectId, 'task:change_status');

  const target = await prisma.taskStatus.findFirst({
    where: { projectId: task.projectId, category },
    orderBy: { order: 'asc' },
  });
  if (!target) throw badRequest(`This project has no ${category.toLowerCase()} status`);
  if (target.id === task.statusId) {
    return { unchanged: true as const, task, status: target };
  }

  await prisma.task.update({
    where: { id: task.id },
    data: {
      statusId: target.id,
      completedAt: target.category === 'DONE' ? new Date() : null,
    },
  });

  await logActivity({
    actorId: auth.id,
    action: 'task.status_changed',
    entityType: 'TASK',
    entityId: task.id,
    projectId: task.projectId,
    taskId: task.id,
    meta: { statusFrom: task.status.name, statusTo: target.name, via: 'telegram' },
  });

  await notify({
    userIds: [
      task.reporterId,
      ...task.assignees.map((a) => a.userId),
      ...task.watchers.map((w) => w.userId),
    ],
    event: 'TASK_STATUS_CHANGED',
    title: `${task.key} moved to ${target.name}`,
    body: `${auth.user.name} moved “${task.title}” to ${target.name} from Telegram.`,
    url: `/projects/${task.project.key}/tasks/${task.key}`,
    actorId: auth.id,
    projectId: task.projectId,
    taskId: task.id,
  });

  return { unchanged: false as const, task, status: target };
};

export const setIssueStatus = async (
  auth: AuthContext,
  issueId: string,
  status: IssueStatus,
) => {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      key: true,
      title: true,
      projectId: true,
      status: true,
      reopenCount: true,
      reporterId: true,
      assigneeId: true,
      project: { select: { key: true } },
      watchers: { select: { userId: true } },
    },
  });
  if (!issue) throw notFound('Issue not found');

  await auth.requireProject(issue.projectId, 'issue:change_status');
  if (issue.status === status) return { unchanged: true as const, issue };

  await prisma.issue.update({
    where: { id: issue.id },
    data: {
      status,
      resolvedAt: status === 'RESOLVED' ? new Date() : null,
      closedAt: status === 'CLOSED' || status === 'WONT_FIX' ? new Date() : null,
      ...(status === 'REOPENED' ? { reopenCount: issue.reopenCount + 1 } : {}),
    },
  });

  await logActivity({
    actorId: auth.id,
    action: status === 'REOPENED' ? 'issue.reopened' : 'issue.status_changed',
    entityType: 'ISSUE',
    entityId: issue.id,
    projectId: issue.projectId,
    issueId: issue.id,
    meta: { statusFrom: issue.status, statusTo: status, via: 'telegram' },
  });

  await notify({
    userIds: [
      issue.reporterId,
      ...(issue.assigneeId ? [issue.assigneeId] : []),
      ...issue.watchers.map((w) => w.userId),
    ],
    event: 'ISSUE_STATUS_CHANGED',
    title: `${issue.key} → ${STATUS_LABEL[status] ?? status}`,
    body: `${auth.user.name} moved “${issue.title}” to ${STATUS_LABEL[status] ?? status} from Telegram.`,
    url: `/projects/${issue.project.key}/issues/${issue.key}`,
    actorId: auth.id,
    projectId: issue.projectId,
    issueId: issue.id,
  });

  return { unchanged: false as const, issue };
};

export const addCommentFromTelegram = async (
  auth: AuthContext,
  entity: 'task' | 'issue',
  id: string,
  body: string,
) => {
  if (entity === 'task') {
    const task = await prisma.task.findUnique({
      where: { id },
      select: {
        id: true,
        key: true,
        title: true,
        projectId: true,
        reporterId: true,
        project: { select: { key: true } },
        assignees: { select: { userId: true } },
        watchers: { select: { userId: true } },
      },
    });
    if (!task) throw notFound('Task not found');
    const access = await auth.requireProject(task.projectId, 'task:view');
    if (!auth.isSuperAdmin && !access.permissions.has('comment:create')) {
      throw forbidden('You do not have permission to comment on this project');
    }

    const comment = await prisma.comment.create({
      data: {
        body,
        entityType: 'TASK',
        authorId: auth.id,
        taskId: task.id,
        projectId: task.projectId,
      },
    });
    await prisma.taskWatcher.createMany({
      data: [{ taskId: task.id, userId: auth.id }],
      skipDuplicates: true,
    });

    await logActivity({
      actorId: auth.id,
      action: 'comment.created',
      entityType: 'TASK',
      entityId: task.id,
      projectId: task.projectId,
      taskId: task.id,
      meta: { commentId: comment.id, via: 'telegram', excerpt: body.slice(0, 140) },
    });

    await notify({
      userIds: [
        task.reporterId,
        ...task.assignees.map((a) => a.userId),
        ...task.watchers.map((w) => w.userId),
      ],
      event: 'TASK_COMMENT',
      title: `New comment on ${task.key}`,
      body: `${auth.user.name}: ${body.slice(0, 180)}`,
      url: `/projects/${task.project.key}/tasks/${task.key}`,
      actorId: auth.id,
      projectId: task.projectId,
      taskId: task.id,
      commentId: comment.id,
    });

    return {
      label: task.key,
      url: `/projects/${task.project.key}/tasks/${task.key}`,
      entity: 'task' as const,
      id: task.id,
    };
  }

  const issue = await prisma.issue.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      title: true,
      projectId: true,
      reporterId: true,
      assigneeId: true,
      project: { select: { key: true } },
      watchers: { select: { userId: true } },
    },
  });
  if (!issue) throw notFound('Issue not found');
  const access = await auth.requireProject(issue.projectId, 'issue:view');
  if (!auth.isSuperAdmin && !access.permissions.has('comment:create')) {
    throw forbidden('You do not have permission to comment on this project');
  }

  const comment = await prisma.comment.create({
    data: {
      body,
      entityType: 'ISSUE',
      authorId: auth.id,
      issueId: issue.id,
      projectId: issue.projectId,
    },
  });
  await prisma.issueWatcher.createMany({
    data: [{ issueId: issue.id, userId: auth.id }],
    skipDuplicates: true,
  });

  await logActivity({
    actorId: auth.id,
    action: 'comment.created',
    entityType: 'ISSUE',
    entityId: issue.id,
    projectId: issue.projectId,
    issueId: issue.id,
    meta: { commentId: comment.id, via: 'telegram', excerpt: body.slice(0, 140) },
  });

  await notify({
    userIds: [
      issue.reporterId,
      ...(issue.assigneeId ? [issue.assigneeId] : []),
      ...issue.watchers.map((w) => w.userId),
    ],
    event: 'ISSUE_COMMENT',
    title: `New comment on ${issue.key}`,
    body: `${auth.user.name}: ${body.slice(0, 180)}`,
    url: `/projects/${issue.project.key}/issues/${issue.key}`,
    actorId: auth.id,
    projectId: issue.projectId,
    issueId: issue.id,
    commentId: comment.id,
  });

  return {
    label: issue.key,
    url: `/projects/${issue.project.key}/issues/${issue.key}`,
    entity: 'issue' as const,
    id: issue.id,
  };
};

export const createIssueFromTelegram = async (
  auth: AuthContext,
  input: {
    projectId: string;
    title: string;
    description: string | null;
    severity: Severity;
    phaseId: string | null;
  },
) => {
  const access = await auth.requireProject(input.projectId, 'issue:create');

  const issue = await prisma.$transaction(async (tx) => {
    const key = await nextIssueKey(tx, access.projectId);
    return tx.issue.create({
      data: {
        key,
        projectId: access.projectId,
        title: input.title,
        description: input.description,
        severity: input.severity,
        priority:
          input.severity === 'BLOCKER' || input.severity === 'CRITICAL' ? 'CRITICAL' : 'MEDIUM',
        phaseId: input.phaseId,
        reporterId: auth.id,
        status: 'OPEN',
        watchers: { create: { userId: auth.id } },
      },
      select: {
        id: true,
        key: true,
        title: true,
        severity: true,
        phase: { select: { name: true } },
        project: { select: { key: true, ownerId: true } },
      },
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'issue.reported',
    entityType: 'ISSUE',
    entityId: issue.id,
    projectId: access.projectId,
    issueId: issue.id,
    meta: { key: issue.key, title: issue.title, severity: issue.severity, via: 'telegram' },
  });

  const escalate = issue.severity === 'CRITICAL' || issue.severity === 'BLOCKER';
  const audience = escalate
    ? (
        await prisma.projectMember.findMany({
          where: {
            projectId: access.projectId,
            role: { permissions: { hasSome: ['issue:assign', 'project:manage_members', '*'] } },
          },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    : [];

  await notify({
    userIds: [...audience, issue.project.ownerId],
    event: 'ISSUE_REPORTED',
    title: `${escalate ? '🚨 ' : ''}${issue.key} reported${issue.phase ? ` in ${issue.phase.name}` : ''}`,
    body: `${auth.user.name} reported “${issue.title}” from Telegram.`,
    url: `/projects/${issue.project.key}/issues/${issue.key}`,
    actorId: auth.id,
    projectId: access.projectId,
    issueId: issue.id,
  });

  return { ...issue, url: `/projects/${issue.project.key}/issues/${issue.key}` };
};

/** Pulls a Telegram photo or document into Cloudinary and attaches it. */
export const attachTelegramFile = async (
  auth: AuthContext,
  args: {
    issueId: string;
    projectId: string;
    fileUrl: string;
    filename: string;
  },
) => {
  const access = await auth.requireProject(args.projectId, 'attachment:upload');
  const uploaded = await uploadRemoteUrl(args.fileUrl, {
    folder: 'issues',
    filename: args.filename,
  });

  await prisma.attachment.create({
    data: {
      filename: uploaded.filename,
      url: uploaded.url,
      publicId: uploaded.publicId,
      mimeType: uploaded.mimeType,
      bytes: uploaded.bytes,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      resourceType: uploaded.resourceType,
      entityType: 'ISSUE',
      uploadedById: auth.id,
      issueId: args.issueId,
      projectId: access.projectId,
    },
  });

  return uploaded;
};
