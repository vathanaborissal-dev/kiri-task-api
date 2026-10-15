import type { Request, Response } from 'express';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import type { AuthContext } from '../../services/authContext.js';
import { logActivity } from '../../services/activity.js';
import { notify } from '../../services/notifications.js';
import type { EntityType } from '../../generated/prisma/enums.js';
import { userSummary } from '../shared/selectors.js';

type Target = {
  taskId?: string;
  issueId?: string;
  releaseId?: string;
  hotfixId?: string;
  projectId?: string;
};

type ResolvedTarget = {
  entityType: EntityType;
  projectId: string;
  projectKey: string;
  /** Prisma relation ids for the comment row. */
  links: Target;
  /** Who should be told about a new comment. */
  audience: string[];
  title: string;
  url: string;
};

/** Resolves the commented-on entity, checks access, and collects its audience. */
const resolveTarget = async (auth: AuthContext, target: Target): Promise<ResolvedTarget> => {
  if (target.taskId) {
    const task = await prisma.task.findFirst({
      where: { OR: [{ id: target.taskId }, { key: target.taskId.toUpperCase() }] },
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
    return {
      entityType: 'TASK',
      projectId: task.projectId,
      projectKey: access.projectKey,
      links: { taskId: task.id, projectId: task.projectId },
      audience: [
        task.reporterId,
        ...task.assignees.map((a) => a.userId),
        ...task.watchers.map((w) => w.userId),
      ],
      title: `${task.key}: ${task.title}`,
      url: `/projects/${task.project.key}/tasks/${task.key}`,
    };
  }

  if (target.issueId) {
    const issue = await prisma.issue.findFirst({
      where: { OR: [{ id: target.issueId }, { key: target.issueId.toUpperCase() }] },
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
    return {
      entityType: 'ISSUE',
      projectId: issue.projectId,
      projectKey: access.projectKey,
      links: { issueId: issue.id, projectId: issue.projectId },
      audience: [
        issue.reporterId,
        ...(issue.assigneeId ? [issue.assigneeId] : []),
        ...issue.watchers.map((w) => w.userId),
      ],
      title: `${issue.key}: ${issue.title}`,
      url: `/projects/${issue.project.key}/issues/${issue.key}`,
    };
  }

  if (target.hotfixId) {
    const hotfix = await prisma.hotfix.findFirst({
      where: { OR: [{ id: target.hotfixId }, { key: target.hotfixId.toUpperCase() }] },
      select: {
        id: true,
        key: true,
        title: true,
        projectId: true,
        requestedById: true,
        assigneeId: true,
        project: { select: { key: true } },
      },
    });
    if (!hotfix) throw notFound('Hotfix not found');
    const access = await auth.requireProject(hotfix.projectId, 'hotfix:view');
    return {
      entityType: 'HOTFIX',
      projectId: hotfix.projectId,
      projectKey: access.projectKey,
      links: { hotfixId: hotfix.id, projectId: hotfix.projectId },
      audience: [hotfix.requestedById, ...(hotfix.assigneeId ? [hotfix.assigneeId] : [])],
      title: `${hotfix.key}: ${hotfix.title}`,
      url: `/projects/${hotfix.project.key}/hotfixes/${hotfix.key}`,
    };
  }

  if (target.releaseId) {
    const release = await prisma.release.findUnique({
      where: { id: target.releaseId },
      select: {
        id: true,
        version: true,
        projectId: true,
        createdById: true,
        project: { select: { key: true } },
      },
    });
    if (!release) throw notFound('Release not found');
    const access = await auth.requireProject(release.projectId, 'release:view');
    return {
      entityType: 'RELEASE',
      projectId: release.projectId,
      projectKey: access.projectKey,
      links: { releaseId: release.id, projectId: release.projectId },
      audience: [release.createdById],
      title: `Release ${release.version}`,
      url: `/projects/${release.project.key}/releases/${release.id}`,
    };
  }

  if (target.projectId) {
    const access = await auth.requireProject(target.projectId, 'project:view');
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: access.projectId },
      select: { name: true, ownerId: true },
    });
    return {
      entityType: 'PROJECT',
      projectId: access.projectId,
      projectKey: access.projectKey,
      links: { projectId: access.projectId },
      audience: [project.ownerId],
      title: project.name,
      url: `/projects/${access.projectKey}`,
    };
  }

  throw badRequest('Tell us which item this comment belongs to');
};

const commentSelect = {
  id: true,
  body: true,
  entityType: true,
  parentId: true,
  editedAt: true,
  createdAt: true,
  author: { select: userSummary },
  mentions: { select: { user: { select: userSummary } } },
  attachments: {
    select: { id: true, filename: true, url: true, mimeType: true, bytes: true, width: true, height: true },
  },
} as const;

const shape = <T extends { mentions?: { user: unknown }[]; [k: string]: unknown }>(comment: T) => {
  const { mentions, ...rest } = comment;
  return { ...rest, mentions: (mentions ?? []).map((m) => m.user) };
};

export const listComments = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<Target & { page: number; pageSize: number }>(req);
  const target = await resolveTarget(auth, query);

  const where = {
    ...(target.links.taskId ? { taskId: target.links.taskId } : {}),
    ...(target.links.issueId ? { issueId: target.links.issueId } : {}),
    ...(target.links.hotfixId ? { hotfixId: target.links.hotfixId } : {}),
    ...(target.links.releaseId ? { releaseId: target.links.releaseId } : {}),
    ...(!target.links.taskId &&
    !target.links.issueId &&
    !target.links.hotfixId &&
    !target.links.releaseId
      ? { projectId: target.links.projectId, entityType: 'PROJECT' as const }
      : {}),
  };

  const [comments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      ...skipTake(query),
      orderBy: { createdAt: 'asc' },
      select: commentSelect,
    }),
    prisma.comment.count({ where }),
  ]);

  res.json(paged(comments.map(shape), total, query));
};

export const createComment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as Target & {
    body: string;
    parentId?: string;
    mentionUserIds?: string[];
    attachmentIds?: string[];
  };

  const target = await resolveTarget(auth, body);
  if (!auth.isSuperAdmin) {
    const access = await auth.project(target.projectId);
    if (!access?.permissions.has('comment:create')) {
      throw forbidden('You do not have permission to comment on this project');
    }
  }

  // Only project members can be mentioned — no reaching outside the project.
  let mentionIds: string[] = [];
  if (body.mentionUserIds?.length) {
    const members = await prisma.projectMember.findMany({
      where: { projectId: target.projectId, userId: { in: body.mentionUserIds } },
      select: { userId: true },
    });
    mentionIds = members.map((m) => m.userId);
  }

  const comment = await prisma.$transaction(async (tx) => {
    const created = await tx.comment.create({
      data: {
        body: body.body,
        entityType: target.entityType,
        authorId: auth.id,
        ...target.links,
        ...(body.parentId ? { parentId: body.parentId } : {}),
        ...(mentionIds.length
          ? { mentions: { create: mentionIds.map((userId) => ({ userId })) } }
          : {}),
      },
      select: commentSelect,
    });

    if (body.attachmentIds?.length) {
      await tx.attachment.updateMany({
        where: { id: { in: body.attachmentIds }, uploadedById: auth.id },
        data: { commentId: created.id },
      });
    }

    // Commenting means you care about what happens next.
    if (target.links.taskId) {
      await tx.taskWatcher.createMany({
        data: [{ taskId: target.links.taskId, userId: auth.id }],
        skipDuplicates: true,
      });
    }
    if (target.links.issueId) {
      await tx.issueWatcher.createMany({
        data: [{ issueId: target.links.issueId, userId: auth.id }],
        skipDuplicates: true,
      });
    }

    return created;
  });

  await logActivity({
    actorId: auth.id,
    action: 'comment.created',
    entityType: target.entityType,
    entityId: target.links.taskId ?? target.links.issueId ?? target.links.hotfixId ?? target.links.releaseId ?? target.projectId,
    projectId: target.projectId,
    taskId: target.links.taskId ?? null,
    issueId: target.links.issueId ?? null,
    hotfixId: target.links.hotfixId ?? null,
    releaseId: target.links.releaseId ?? null,
    meta: { commentId: comment.id, excerpt: body.body.slice(0, 140) },
  });

  const excerpt = body.body.length > 180 ? `${body.body.slice(0, 180)}…` : body.body;

  // Reply without leaving Telegram. The callback handlers for these already
  // exist — this just puts them where somebody has just been @mentioned.
  const replyButton = target.links.taskId
    ? [[{ text: '💬 Reply', callbackData: `task:comment:${target.links.taskId}` }]]
    : target.links.issueId
      ? [[{ text: '💬 Reply', callbackData: `issue:comment:${target.links.issueId}` }]]
      : undefined;

  if (mentionIds.length) {
    await notify({
      userIds: mentionIds,
      event: 'MENTION',
      title: `${auth.user.name} mentioned you on ${target.title}`,
      body: excerpt,
      url: target.url,
      ...(replyButton ? { telegramButtons: replyButton } : {}),
      actorId: auth.id,
      projectId: target.projectId,
      taskId: target.links.taskId ?? null,
      issueId: target.links.issueId ?? null,
      hotfixId: target.links.hotfixId ?? null,
      releaseId: target.links.releaseId ?? null,
      commentId: comment.id,
    });
  }

  const others = target.audience.filter((id) => !mentionIds.includes(id));
  await notify({
    userIds: others,
    event: target.entityType === 'ISSUE' ? 'ISSUE_COMMENT' : 'TASK_COMMENT',
    title: `New comment on ${target.title}`,
    body: `${auth.user.name}: ${excerpt}`,
    url: target.url,
    ...(replyButton ? { telegramButtons: replyButton } : {}),
    actorId: auth.id,
    projectId: target.projectId,
    taskId: target.links.taskId ?? null,
    issueId: target.links.issueId ?? null,
    hotfixId: target.links.hotfixId ?? null,
    releaseId: target.links.releaseId ?? null,
    commentId: comment.id,
  });

  res.status(201).json({ data: shape(comment) });
};

export const updateComment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const commentId = String(req.params.commentId);
  const body = req.body as { body: string; mentionUserIds?: string[] };

  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, projectId: true },
  });
  if (!existing) throw notFound('Comment not found');

  if (existing.authorId !== auth.id) {
    if (!existing.projectId) throw forbidden('You can only edit your own comments');
    await auth.requireProject(existing.projectId, 'comment:moderate');
  }

  const comment = await prisma.$transaction(async (tx) => {
    if (body.mentionUserIds) {
      await tx.commentMention.deleteMany({ where: { commentId } });
      if (body.mentionUserIds.length && existing.projectId) {
        const members = await tx.projectMember.findMany({
          where: { projectId: existing.projectId, userId: { in: body.mentionUserIds } },
          select: { userId: true },
        });
        if (members.length) {
          await tx.commentMention.createMany({
            data: members.map((m) => ({ commentId, userId: m.userId })),
          });
        }
      }
    }
    return tx.comment.update({
      where: { id: commentId },
      data: { body: body.body, editedAt: new Date() },
      select: commentSelect,
    });
  });

  res.json({ data: shape(comment) });
};

export const deleteComment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const commentId = String(req.params.commentId);
  const existing = await prisma.comment.findUnique({
    where: { id: commentId },
    select: { authorId: true, projectId: true },
  });
  if (!existing) throw notFound('Comment not found');

  if (existing.authorId !== auth.id) {
    if (!existing.projectId) throw forbidden('You can only delete your own comments');
    await auth.requireProject(existing.projectId, 'comment:moderate');
  }

  await prisma.comment.delete({ where: { id: commentId } });
  res.status(204).end();
};

/** People who can be @mentioned in this context. */
export const listMentionables = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const projectId = String(req.query.projectId ?? '');
  const access = await auth.requireProject(projectId, 'project:view');
  const members = await prisma.projectMember.findMany({
    where: { projectId: access.projectId, user: { isActive: true } },
    select: { user: { select: userSummary }, role: { select: { name: true } } },
    orderBy: { user: { name: 'asc' } },
  });
  res.json({
    data: members.map((m) => ({ ...m.user, roleName: m.role.name })),
  });
};
