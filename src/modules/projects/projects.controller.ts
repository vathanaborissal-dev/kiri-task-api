import type { Request, Response } from 'express';
import { DEFAULT_PROJECT_ROLE_KEY } from '../../config/systemRoles.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { logActivity } from '../../services/activity.js';
import { notify } from '../../services/notifications.js';
import { phaseSummary, roleSummary, statusSummary, userSummary } from '../shared/selectors.js';
import { progressForProjects, scaffoldProject, suggestProjectKey } from './projects.service.js';

export const listProjects = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<{
    page: number;
    pageSize: number;
    search?: string;
    status?: string;
    includeArchived: boolean;
    sort: 'name' | 'createdAt' | 'targetDate' | 'progress';
  }>(req);

  const accessible = await auth.accessibleProjectIds();
  if (accessible.length === 0) {
    res.json(paged([], 0, query));
    return;
  }

  const where = {
    id: { in: accessible },
    ...(query.status ? { status: query.status as 'ACTIVE' } : {}),
    ...(query.includeArchived || query.status ? {} : { archivedAt: null }),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { key: { contains: query.search.toUpperCase() } },
            { description: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
      ...(query.sort === 'progress' ? {} : skipTake(query)),
      orderBy:
        query.sort === 'createdAt'
          ? { createdAt: 'desc' }
          : query.sort === 'targetDate'
            ? { targetDate: 'asc' }
            : { name: 'asc' },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        color: true,
        status: true,
        startDate: true,
        targetDate: true,
        completedAt: true,
        archivedAt: true,
        createdAt: true,
        owner: { select: userSummary },
        members: {
          select: { user: { select: userSummary }, role: { select: roleSummary } },
          take: 8,
        },
        _count: { select: { members: true, tasks: true, issues: true, releases: true } },
      },
    }),
    prisma.project.count({ where }),
  ]);

  const progress = await progressForProjects(projects.map((p) => p.id));

  let data = projects.map(({ _count, ...project }) => ({
    ...project,
    memberCount: _count.members,
    taskCount: _count.tasks,
    issueCount: _count.issues,
    releaseCount: _count.releases,
    stats: progress.get(project.id)!,
  }));

  if (query.sort === 'progress') {
    data = data
      .sort((a, b) => b.stats.progress - a.stats.progress)
      .slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  }

  res.json(paged(data, total, query));
};

export const getProject = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:view');

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: access.projectId },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      color: true,
      status: true,
      startDate: true,
      targetDate: true,
      completedAt: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      owner: { select: userSummary },
      createdBy: { select: userSummary },
      members: {
        select: {
          id: true,
          responsibilities: true,
          joinedAt: true,
          user: { select: userSummary },
          role: { select: roleSummary },
        },
        orderBy: { user: { name: 'asc' } },
      },
      statuses: { select: statusSummary, orderBy: { order: 'asc' } },
      phases: {
        select: { ...phaseSummary, description: true },
        orderBy: { order: 'asc' },
      },
      labels: { select: { id: true, name: true, color: true }, orderBy: { name: 'asc' } },
      milestones: {
        select: {
          id: true,
          name: true,
          description: true,
          dueDate: true,
          completedAt: true,
          _count: { select: { tasks: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { name: 'asc' }],
      },
    },
  });

  const progress = await progressForProjects([project.id]);

  res.json({
    data: {
      ...project,
      milestones: project.milestones.map(({ _count, ...m }) => ({ ...m, taskCount: _count.tasks })),
      stats: progress.get(project.id)!,
      myRole: access.role,
      myPermissions: [...access.permissions],
    },
  });
};

export const createProject = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    name: string;
    key?: string;
    description?: string | null;
    color?: string;
    status?: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED';
    ownerId?: string;
    startDate?: Date | null;
    targetDate?: Date | null;
  };

  const key = body.key ?? (await suggestProjectKey(body.name));
  if (await prisma.project.findUnique({ where: { key }, select: { id: true } })) {
    throw conflict(`The project code ${key} is already in use`);
  }

  const ownerId = body.ownerId ?? auth.id;
  if (ownerId !== auth.id) {
    const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { isActive: true } });
    if (!owner?.isActive) throw badRequest('Choose an active person as the project owner');
  }

  const managerRole = await prisma.role.findFirst({
    where: { scope: 'PROJECT', key: 'project-manager' },
    select: { id: true },
  });
  const defaultRole = await prisma.role.findFirst({
    where: { scope: 'PROJECT', OR: [{ isDefault: true }, { key: DEFAULT_PROJECT_ROLE_KEY }] },
    orderBy: { isDefault: 'desc' },
    select: { id: true },
  });
  const ownerRoleId = managerRole?.id ?? defaultRole?.id;
  if (!ownerRoleId) throw badRequest('No project roles exist yet. Create one first.');

  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: {
        key,
        name: body.name,
        description: body.description ?? null,
        ...(body.color ? { color: body.color } : {}),
        ...(body.status ? { status: body.status } : {}),
        ownerId,
        createdById: auth.id,
        ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
        ...(body.targetDate !== undefined ? { targetDate: body.targetDate } : {}),
      },
    });

    await scaffoldProject(tx, created.id);

    const memberIds = new Set([ownerId, auth.id]);
    await tx.projectMember.createMany({
      data: [...memberIds].map((userId) => ({
        projectId: created.id,
        userId,
        roleId: ownerRoleId,
        responsibilities: userId === ownerId ? 'Project owner' : null,
      })),
      skipDuplicates: true,
    });

    return created;
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.created',
    entityType: 'PROJECT',
    entityId: project.id,
    projectId: project.id,
    meta: { name: project.name, key: project.key },
  });

  res.status(201).json({ data: project });
};

export const updateProject = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:update');
  const body = req.body as Record<string, unknown>;

  if (body.ownerId) {
    const owner = await prisma.user.findUnique({
      where: { id: String(body.ownerId) },
      select: { isActive: true },
    });
    if (!owner?.isActive) throw badRequest('Choose an active person as the project owner');
  }

  const before = await prisma.project.findUniqueOrThrow({
    where: { id: access.projectId },
    select: { status: true, name: true, ownerId: true, targetDate: true },
  });

  const data: Record<string, unknown> = { ...body };
  if (body.status === 'COMPLETED' && before.status !== 'COMPLETED') data.completedAt = new Date();
  if (body.status && body.status !== 'COMPLETED') data.completedAt = null;
  if (body.status === 'ARCHIVED') {
    auth.assert('project:archive');
    data.archivedAt = new Date();
  } else if (body.status && before.status === 'ARCHIVED') {
    data.archivedAt = null;
  }

  const project = await prisma.project.update({ where: { id: access.projectId }, data });

  await logActivity({
    actorId: auth.id,
    action: 'project.updated',
    entityType: 'PROJECT',
    entityId: project.id,
    projectId: project.id,
    meta: { fields: Object.keys(body) },
  });

  if (body.ownerId && body.ownerId !== before.ownerId) {
    await notify({
      userIds: [String(body.ownerId)],
      event: 'PROJECT_MEMBER_ADDED',
      title: `You now own ${project.name}`,
      body: `${auth.user.name} made you the owner of ${project.key}.`,
      url: `/projects/${project.key}`,
      actorId: auth.id,
      projectId: project.id,
    });
  }

  res.json({ data: project });
};

export const archiveProject = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:archive');
  const restore = req.method === 'DELETE' ? false : Boolean((req.body as { restore?: boolean })?.restore);

  const project = await prisma.project.update({
    where: { id: access.projectId },
    data: restore
      ? { archivedAt: null, status: 'ACTIVE' }
      : { archivedAt: new Date(), status: 'ARCHIVED' },
  });

  await logActivity({
    actorId: auth.id,
    action: restore ? 'project.restored' : 'project.archived',
    entityType: 'PROJECT',
    entityId: project.id,
    projectId: project.id,
  });

  res.json({ data: project });
};

export const deleteProject = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:delete');
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: access.projectId },
    select: { key: true, name: true },
  });

  const confirmation = String((req.body as { confirm?: string })?.confirm ?? '');
  if (confirmation !== project.key) {
    throw badRequest(`Type the project code (${project.key}) to confirm deletion`);
  }

  // Tasks require a status and deployments require a phase, and Postgres gives
  // no ordering guarantee between the cascades that remove those rows — so the
  // dependants come out first, inside one transaction.
  await prisma.$transaction(async (tx) => {
    await tx.deployment.deleteMany({ where: { release: { projectId: access.projectId } } });
    await tx.task.deleteMany({ where: { projectId: access.projectId } });
    await tx.project.delete({ where: { id: access.projectId } });
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.deleted',
    entityType: 'PROJECT',
    entityId: access.projectId,
    meta: { name: project.name, key: project.key },
  });
  res.status(204).end();
};

// --- Members ---------------------------------------------------------------

export const listMembers = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:view');
  const members = await prisma.projectMember.findMany({
    where: { projectId: access.projectId },
    orderBy: { user: { name: 'asc' } },
    select: {
      id: true,
      responsibilities: true,
      joinedAt: true,
      user: { select: { ...userSummary, timezone: true, telegramChatId: true } },
      role: { select: { ...roleSummary, permissions: true } },
    },
  });
  res.json({
    data: members.map(({ user: { telegramChatId, ...user }, ...member }) => ({
      ...member,
      user: { ...user, telegramLinked: telegramChatId !== null },
    })),
  });
};

export const addMember = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_members',
  );
  const body = req.body as { userId: string; roleId: string; responsibilities?: string | null };

  const [user, role, project] = await Promise.all([
    prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, isActive: true, name: true } }),
    prisma.role.findUnique({ where: { id: body.roleId }, select: { id: true, scope: true, name: true } }),
    prisma.project.findUniqueOrThrow({
      where: { id: access.projectId },
      select: { key: true, name: true },
    }),
  ]);

  if (!user?.isActive) throw badRequest('That person is not an active member of the workspace');
  if (!role) throw badRequest('That role does not exist');
  if (role.scope !== 'PROJECT') throw badRequest('Pick a project-level role');

  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: access.projectId, userId: body.userId } },
    select: { id: true },
  });
  if (existing) throw conflict('That person is already a member of this project');

  const member = await prisma.projectMember.create({
    data: {
      projectId: access.projectId,
      userId: body.userId,
      roleId: body.roleId,
      responsibilities: body.responsibilities ?? null,
    },
    select: {
      id: true,
      responsibilities: true,
      joinedAt: true,
      user: { select: userSummary },
      role: { select: roleSummary },
    },
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.member_added',
    entityType: 'PROJECT',
    entityId: access.projectId,
    projectId: access.projectId,
    meta: { userId: body.userId, userName: user.name, role: role.name },
  });

  await notify({
    userIds: [body.userId],
    event: 'PROJECT_MEMBER_ADDED',
    title: `Added to ${project.name}`,
    body: `${auth.user.name} added you to ${project.key} as ${role.name}.`,
    url: `/projects/${project.key}`,
    actorId: auth.id,
    projectId: access.projectId,
  });

  res.status(201).json({ data: member });
};

export const updateMember = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_members',
  );
  const body = req.body as { roleId?: string; responsibilities?: string | null };

  if (body.roleId) {
    const role = await prisma.role.findUnique({
      where: { id: body.roleId },
      select: { scope: true },
    });
    if (role?.scope !== 'PROJECT') throw badRequest('Pick a project-level role');
  }

  const member = await prisma.projectMember.update({
    where: { id: String(req.params.memberId) },
    data: body,
    select: {
      id: true,
      responsibilities: true,
      user: { select: userSummary },
      role: { select: roleSummary },
    },
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.member_updated',
    entityType: 'PROJECT',
    entityId: access.projectId,
    projectId: access.projectId,
    meta: { userId: member.user.id, role: member.role.name },
  });

  res.json({ data: member });
};

export const removeMember = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_members',
  );

  const member = await prisma.projectMember.findUnique({
    where: { id: String(req.params.memberId) },
    select: { id: true, userId: true, projectId: true, user: { select: { name: true } } },
  });
  if (!member || member.projectId !== access.projectId) throw notFound('That member was not found');

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: access.projectId },
    select: { ownerId: true },
  });
  if (project.ownerId === member.userId) {
    throw forbidden('Transfer project ownership before removing the owner');
  }

  await prisma.projectMember.delete({ where: { id: member.id } });
  await logActivity({
    actorId: auth.id,
    action: 'project.member_removed',
    entityType: 'PROJECT',
    entityId: access.projectId,
    projectId: access.projectId,
    meta: { userId: member.userId, userName: member.user.name },
  });

  res.status(204).end();
};

/** People who could still be added to the project. */
export const listAssignableUsers = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:view');
  const users = await prisma.user.findMany({
    where: { isActive: true, memberships: { none: { projectId: access.projectId } } },
    select: userSummary,
    orderBy: { name: 'asc' },
    take: 200,
  });
  res.json({ data: users });
};
