import type { Request, Response } from 'express';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { invitationEmail, sendEmail } from '../../lib/email.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { logActivity } from '../../services/activity.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { projectSummary, roleSummary, userSummary } from '../shared/selectors.js';

const INVITE_TTL_DAYS = 7;

export const listUsers = async (req: Request, res: Response) => {
  const query = q<{
    page: number;
    pageSize: number;
    search?: string;
    roleId?: string;
    status: 'all' | 'active' | 'inactive';
    projectId?: string;
    sort: 'name' | 'createdAt' | 'lastLoginAt';
  }>(req);

  const where = {
    ...(query.status === 'all' ? {} : { isActive: query.status === 'active' }),
    ...(query.roleId ? { globalRoleId: query.roleId } : {}),
    ...(query.projectId ? { memberships: { some: { projectId: query.projectId } } } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { jobTitle: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      ...skipTake(query),
      orderBy:
        query.sort === 'name'
          ? { name: 'asc' }
          : query.sort === 'createdAt'
            ? { createdAt: 'desc' }
            : { lastLoginAt: 'desc' },
      select: {
        ...userSummary,
        responsibilities: true,
        timezone: true,
        telegramChatId: true,
        lastLoginAt: true,
        createdAt: true,
        globalRole: { select: roleSummary },
        _count: { select: { memberships: true, taskAssignees: true, assignedIssues: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.json(
    paged(
      users.map(({ telegramChatId, _count, ...user }) => ({
        ...user,
        telegramLinked: telegramChatId !== null,
        projectCount: _count.memberships,
        openTaskCount: _count.taskAssignees,
        openIssueCount: _count.assignedIssues,
      })),
      total,
      query,
    ),
  );
};

/** How far back "finished recently" looks on a person's page. */
const COMPLETED_WINDOW_DAYS = 30;

export const getUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const userId = String(req.params.userId);
  const self = userId === auth.id;
  if (!self) auth.assert('user:view');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...userSummary,
      responsibilities: true,
      timezone: true,
      lastLoginAt: true,
      createdAt: true,
      telegramChatId: true,
      telegramUsername: true,
      globalRole: { select: { ...roleSummary, permissions: true } },
      memberships: {
        select: {
          responsibilities: true,
          joinedAt: true,
          project: { select: projectSummary },
          role: { select: roleSummary },
        },
        orderBy: { project: { name: 'asc' } },
      },
    },
  });
  if (!user) throw notFound('That person could not be found');

  const accessible = await auth.accessibleProjectIds();

  // "What is this person up to" needs more than three counts: what they are
  // carrying, what is stuck on them, and what they have actually finished.
  // Everything is restricted to projects the caller can already see, so this
  // page never becomes a way around project access.
  const assigned: Prisma.TaskWhereInput = {
    projectId: { in: accessible },
    assignees: { some: { userId } },
  };
  const openWork: Prisma.TaskWhereInput['status'] = {
    category: { notIn: ['DONE', 'CANCELED'] },
  };
  const since = new Date(Date.now() - COMPLETED_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [
    openTasks,
    openIssues,
    overdueTasks,
    blockedTasks,
    completedTasks,
    reportedIssues,
    openHotfixes,
    issues,
    recentlyCompleted,
  ] = await Promise.all([
    prisma.task.count({ where: { ...assigned, status: openWork } }),
    prisma.issue.count({
      where: {
        projectId: { in: accessible },
        assigneeId: userId,
        status: { notIn: ['CLOSED', 'RESOLVED', 'WONT_FIX'] },
      },
    }),
    prisma.task.count({ where: { ...assigned, dueDate: { lt: new Date() }, status: openWork } }),
    prisma.task.count({ where: { ...assigned, status: { category: 'BLOCKED' } } }),
    prisma.task.count({ where: { ...assigned, completedAt: { gte: since } } }),
    prisma.issue.count({ where: { projectId: { in: accessible }, reporterId: userId } }),
    prisma.hotfix.count({
      where: {
        projectId: { in: accessible },
        assigneeId: userId,
        status: { notIn: ['DEPLOYED', 'VERIFIED', 'REJECTED'] },
      },
    }),
    prisma.issue.findMany({
      where: {
        projectId: { in: accessible },
        assigneeId: userId,
        status: { notIn: ['CLOSED', 'RESOLVED', 'WONT_FIX'] },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 8,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        severity: true,
        dueDate: true,
        project: { select: projectSummary },
      },
    }),
    prisma.task.findMany({
      where: { ...assigned, completedAt: { gte: since } },
      orderBy: { completedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        key: true,
        title: true,
        completedAt: true,
        project: { select: projectSummary },
      },
    }),
  ]);

  const { telegramChatId, ...rest } = user;
  res.json({
    data: {
      ...rest,
      telegramLinked: telegramChatId !== null,
      workload: {
        openTasks,
        openIssues,
        overdueTasks,
        blockedTasks,
        completedTasks,
        reportedIssues,
        openHotfixes,
      },
      completedWindowDays: COMPLETED_WINDOW_DAYS,
      issues,
      recentlyCompleted,
    },
  });
};

export const updateUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const userId = String(req.params.userId);
  const body = req.body as Record<string, unknown>;

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, isActive: true, globalRoleId: true },
  });
  if (!target) throw notFound('That person could not be found');

  const self = userId === auth.id;
  if (!self) auth.assert('user:update');
  if (body.globalRoleId !== undefined && body.globalRoleId !== target.globalRoleId) {
    auth.assert('user:assign_role', 'You cannot change workspace roles');
    if (self) throw forbidden('You cannot change your own workspace role');
  }
  if (body.isActive !== undefined && body.isActive !== target.isActive) {
    auth.assert('user:manage_status');
    if (self) throw forbidden('You cannot deactivate your own account');
  }
  if (self && body.globalRoleId === undefined && body.isActive === undefined) {
    // Editing your own profile is always allowed.
  }

  const user = await prisma.user.update({
    where: { id: userId },
    data: body,
    select: { ...userSummary, globalRole: { select: roleSummary }, responsibilities: true },
  });

  if (body.isActive === false) await revokeAllSessions(userId);

  await logActivity({
    actorId: auth.id,
    action: body.isActive === false ? 'user.deactivated' : 'user.updated',
    entityType: 'USER',
    entityId: userId,
    meta: { fields: Object.keys(body) },
  });

  res.json({ data: user });
};

export const deleteUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const userId = String(req.params.userId);
  if (userId === auth.id) throw forbidden('You cannot delete your own account');

  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, ownedProjects: { select: { id: true }, take: 1 } },
  });
  if (!target) throw notFound('That person could not be found');
  if (target.ownedProjects.length > 0) {
    throw conflict('Reassign the projects this person owns before deleting their account.');
  }

  // Their history is deliberately not erasable: a task's reporter, a comment's
  // author and a deployment's operator all have to stay answerable. Rather than
  // let Postgres refuse with a foreign-key error, say what is in the way.
  const [tasks, issues, hotfixes, releases, deployments, comments, attachments, projects, invitations] =
    await Promise.all([
      prisma.task.count({ where: { reporterId: userId } }),
      prisma.issue.count({ where: { reporterId: userId } }),
      prisma.hotfix.count({ where: { requestedById: userId } }),
      prisma.release.count({ where: { createdById: userId } }),
      prisma.deployment.count({ where: { deployedById: userId } }),
      prisma.comment.count({ where: { authorId: userId } }),
      prisma.attachment.count({ where: { uploadedById: userId } }),
      prisma.project.count({ where: { createdById: userId } }),
      prisma.invitation.count({ where: { invitedById: userId } }),
    ]);

  const history = [
    [tasks, 'task', 'tasks reported'],
    [issues, 'issue', 'issues reported'],
    [hotfixes, 'hotfix', 'hotfixes raised'],
    [releases, 'release', 'releases created'],
    [deployments, 'deployment', 'deployments recorded'],
    [comments, 'comment', 'comments written'],
    [attachments, 'attachment', 'files uploaded'],
    [projects, 'project', 'projects created'],
    [invitations, 'invitation', 'invitations sent'],
  ] as const;

  const blocking = history.filter(([count]) => count > 0);
  if (blocking.length > 0) {
    const summary = blocking
      .map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`)
      .join(', ');
    throw conflict(
      `${target.name} has history that has to be kept: ${summary}. Deactivate the account instead — that revokes access immediately and leaves the record intact.`,
      { blocking: Object.fromEntries(blocking.map(([count, , plural]) => [plural, count])) },
    );
  }

  await prisma.user.delete({ where: { id: userId } });
  await logActivity({
    actorId: auth.id,
    action: 'user.deleted',
    entityType: 'USER',
    entityId: userId,
    meta: { name: target.name },
  });
  res.status(204).end();
};

export const inviteUser = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    email: string;
    name?: string;
    roleId: string;
    projectGrants?: { projectId: string; roleId: string }[];
  };

  const [existingUser, role] = await Promise.all([
    prisma.user.findUnique({ where: { email: body.email }, select: { id: true } }),
    prisma.role.findUnique({ where: { id: body.roleId } }),
  ]);
  if (existingUser) throw conflict('Someone with that email is already in the workspace');
  if (!role) throw badRequest('That workspace role does not exist');
  if (role.scope !== 'GLOBAL') throw badRequest('Pick a workspace-level role for the invitation');

  // Only grant project access the inviter can actually administer.
  for (const grant of body.projectGrants ?? []) {
    await auth.requireProject(grant.projectId, 'project:manage_members');
  }

  const token = randomToken(32);
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.invitation.updateMany({
      where: { email: body.email, status: 'PENDING' },
      data: { status: 'REVOKED' },
    });
    return tx.invitation.create({
      data: {
        email: body.email,
        name: body.name ?? null,
        tokenHash: sha256(token),
        roleId: body.roleId,
        invitedById: auth.id,
        projectGrants: body.projectGrants ?? [],
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
      include: { role: { select: roleSummary } },
    });
  });

  const acceptUrl = `${env.WEB_APP_URL}/accept-invitation?token=${encodeURIComponent(token)}`;
  const emailed = await sendEmail({
    to: [{ email: body.email, ...(body.name ? { name: body.name } : {}) }],
    subject: `${auth.user.name} invited you to Kiri Task`,
    html: invitationEmail({
      inviterName: auth.user.name,
      roleName: role.name,
      acceptUrl,
      expiresInDays: INVITE_TTL_DAYS,
    }),
  });

  await logActivity({
    actorId: auth.id,
    action: 'user.invited',
    entityType: 'USER',
    entityId: invitation.id,
    meta: { email: body.email, role: role.name },
  });

  res.status(201).json({
    data: { ...invitation, projectGrants: undefined },
    emailed,
    // Surfaced so an admin can share the link manually when email is not configured.
    acceptUrl,
  });
};

export const listInvitations = async (_req: Request, res: Response) => {
  const invitations = await prisma.invitation.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      email: true,
      name: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      role: { select: roleSummary },
      invitedBy: { select: userSummary },
    },
  });
  res.json({ data: invitations });
};

export const revokeInvitation = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = String(req.params.invitationId);
  const result = await prisma.invitation.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REVOKED' },
  });
  if (result.count === 0) throw notFound('That invitation is no longer pending');
  await logActivity({
    actorId: auth.id,
    action: 'user.invitation_revoked',
    entityType: 'USER',
    entityId: id,
  });
  res.status(204).end();
};

/** Workload across every project the caller can see. */
export const getWorkload = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const projectIds = await auth.accessibleProjectIds();
  const projectFilter = String(req.query.projectId ?? '');
  const scoped = projectFilter
    ? projectIds.filter((id) => id === projectFilter)
    : projectIds;

  if (scoped.length === 0) {
    res.json({ data: [] });
    return;
  }

  const members = await prisma.user.findMany({
    where: { isActive: true, memberships: { some: { projectId: { in: scoped } } } },
    select: {
      ...userSummary,
      taskAssignees: {
        where: { task: { projectId: { in: scoped } } },
        select: {
          task: {
            select: {
              id: true,
              dueDate: true,
              priority: true,
              estimateHours: true,
              status: { select: { category: true } },
            },
          },
        },
      },
      _count: {
        select: {
          assignedIssues: {
            where: {
              projectId: { in: scoped },
              status: { notIn: ['CLOSED', 'RESOLVED', 'WONT_FIX'] },
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  const now = new Date();
  res.json({
    data: members.map(({ taskAssignees, _count, ...user }) => {
      const open = taskAssignees
        .map((t) => t.task)
        .filter((t) => t.status.category !== 'DONE' && t.status.category !== 'CANCELED');
      return {
        ...user,
        openTasks: open.length,
        inProgress: open.filter((t) => t.status.category === 'IN_PROGRESS').length,
        blocked: open.filter((t) => t.status.category === 'BLOCKED').length,
        overdue: open.filter((t) => t.dueDate && t.dueDate < now).length,
        critical: open.filter((t) => t.priority === 'CRITICAL' || t.priority === 'HIGH').length,
        estimatedHours: open.reduce((sum, t) => sum + (t.estimateHours ?? 0), 0),
        openIssues: _count.assignedIssues,
      };
    }),
  });
};
