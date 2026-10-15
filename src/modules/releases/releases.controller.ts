import type { Request, Response } from 'express';
import { badRequest, notFound } from '../../lib/errors.js';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { diffFields, logActivity } from '../../services/activity.js';
import { notify } from '../../services/notifications.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DeploymentStatus, ReleaseStatus } from '../../generated/prisma/enums.js';
import { phaseSummary, userSummary } from '../shared/selectors.js';

const releaseListSelect = {
  id: true,
  version: true,
  name: true,
  description: true,
  status: true,
  isHotfix: true,
  plannedDate: true,
  releasedAt: true,
  createdAt: true,
  project: { select: { id: true, key: true, name: true, color: true } },
  phase: { select: phaseSummary },
  createdBy: { select: userSummary },
  _count: { select: { tasks: true, issues: true, hotfixes: true, deployments: true } },
} as const;

const releaseDetailSelect = {
  ...releaseListSelect,
  releaseNotes: true,
  tasks: {
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      priority: true,
      qaStatus: true,
      status: { select: { id: true, name: true, category: true, color: true } },
      phase: { select: phaseSummary },
      assignees: { select: { user: { select: userSummary } } },
    },
    orderBy: { key: 'asc' },
  },
  issues: {
    select: {
      id: true,
      key: true,
      title: true,
      status: true,
      severity: true,
      assignee: { select: userSummary },
    },
    orderBy: { key: 'asc' },
  },
  hotfixes: {
    select: { id: true, key: true, title: true, status: true, severity: true },
  },
  deployments: {
    select: {
      id: true,
      status: true,
      notes: true,
      deployedAt: true,
      phase: { select: phaseSummary },
      deployedBy: { select: userSummary },
    },
    orderBy: { deployedAt: 'desc' },
  },
} as const;

const shape = <T extends { _count?: Record<string, number>; [k: string]: unknown }>(release: T) => {
  const { _count, ...rest } = release;
  return {
    ...rest,
    counts: {
      tasks: _count?.tasks ?? 0,
      issues: _count?.issues ?? 0,
      hotfixes: _count?.hotfixes ?? 0,
      deployments: _count?.deployments ?? 0,
    },
  };
};

const findReleaseRef = async (releaseId: string) => {
  const release = await prisma.release.findUnique({
    where: { id: releaseId },
    select: { id: true, projectId: true, version: true, project: { select: { key: true } } },
  });
  if (!release) throw notFound('Release not found');
  return release;
};

export const listReleases = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<{
    page: number;
    pageSize: number;
    projectId?: string;
    status?: string[];
    phaseId?: string[];
    isHotfix?: boolean;
    search?: string;
    sort: 'createdAt' | 'plannedDate' | 'releasedAt' | 'version';
    order: 'asc' | 'desc';
  }>(req);

  const projectIds = query.projectId
    ? [(await auth.requireProject(query.projectId, 'release:view')).projectId]
    : await auth.projectIdsWith('release:view');

  const where: Prisma.ReleaseWhereInput = {
    projectId: { in: projectIds },
    ...(query.status ? { status: { in: query.status as ReleaseStatus[] } } : {}),
    ...(query.phaseId ? { phaseId: { in: query.phaseId } } : {}),
    ...(query.isHotfix !== undefined ? { isHotfix: query.isHotfix } : {}),
    ...(query.search
      ? {
          OR: [
            { version: { contains: query.search, mode: 'insensitive' } },
            { name: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [releases, total] = await Promise.all([
    prisma.release.findMany({
      where,
      ...skipTake(query),
      orderBy:
        query.sort === 'plannedDate'
          ? [{ plannedDate: { sort: query.order, nulls: 'last' } }]
          : query.sort === 'releasedAt'
            ? [{ releasedAt: { sort: query.order, nulls: 'last' } }]
            : query.sort === 'version'
              ? [{ version: query.order }]
              : [{ createdAt: query.order }],
      select: releaseListSelect,
    }),
    prisma.release.count({ where }),
  ]);

  res.json(paged(releases.map(shape), total, query));
};

export const getRelease = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  await auth.requireProject(ref.projectId, 'release:view');

  const release = await prisma.release.findUniqueOrThrow({
    where: { id: ref.id },
    select: releaseDetailSelect,
  });

  const readiness = {
    totalTasks: release.tasks.length,
    doneTasks: release.tasks.filter((t) => t.status.category === 'DONE').length,
    qaPassed: release.tasks.filter((t) => t.qaStatus === 'PASSED').length,
    qaFailed: release.tasks.filter((t) => t.qaStatus === 'FAILED').length,
    qaPending: release.tasks.filter(
      (t) => t.qaStatus === 'PENDING' || t.qaStatus === 'IN_TESTING',
    ).length,
    openIssues: release.issues.filter(
      (i) => !['CLOSED', 'RESOLVED', 'WONT_FIX'].includes(i.status),
    ).length,
  };

  res.json({
    data: {
      ...shape(release),
      tasks: release.tasks.map(({ assignees, ...t }) => ({
        ...t,
        assignees: assignees.map((a) => a.user),
      })),
      readiness,
    },
  });
};

export const createRelease = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    projectId: string;
    version: string;
    name?: string | null;
    description?: string | null;
    releaseNotes?: string | null;
    status?: ReleaseStatus;
    isHotfix?: boolean;
    plannedDate?: Date | null;
    taskIds?: string[];
    issueIds?: string[];
  };

  const access = await auth.requireProject(body.projectId, 'release:create');

  const release = await prisma.$transaction(async (tx) => {
    const created = await tx.release.create({
      data: {
        projectId: access.projectId,
        version: body.version,
        name: body.name ?? null,
        description: body.description ?? null,
        releaseNotes: body.releaseNotes ?? null,
        ...(body.status ? { status: body.status } : {}),
        isHotfix: body.isHotfix ?? false,
        ...(body.plannedDate !== undefined ? { plannedDate: body.plannedDate } : {}),
        createdById: auth.id,
      },
    });

    if (body.taskIds?.length) {
      await tx.task.updateMany({
        where: { id: { in: body.taskIds }, projectId: access.projectId },
        data: { releaseId: created.id },
      });
    }
    if (body.issueIds?.length) {
      await tx.issue.updateMany({
        where: { id: { in: body.issueIds }, projectId: access.projectId },
        data: { releaseId: created.id },
      });
    }

    return created;
  });

  await logActivity({
    actorId: auth.id,
    action: 'release.created',
    entityType: 'RELEASE',
    entityId: release.id,
    projectId: access.projectId,
    releaseId: release.id,
    meta: { version: release.version, isHotfix: release.isHotfix },
  });

  res.status(201).json({ data: release });
};

export const updateRelease = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  const access = await auth.requireProject(ref.projectId, 'release:update');
  const body = req.body as Record<string, unknown>;

  const before = await prisma.release.findUniqueOrThrow({
    where: { id: ref.id },
    select: {
      version: true,
      name: true,
      status: true,
      releasedAt: true,
      plannedDate: true,
      isHotfix: true,
    },
  });

  const data: Record<string, unknown> = { ...body };
  if (body.status === 'RELEASED' && !before.releasedAt && body.releasedAt === undefined) {
    data.releasedAt = new Date();
  }

  const release = await prisma.release.update({ where: { id: ref.id }, data });

  const changes = diffFields(before as Record<string, unknown>, data, [
    'version',
    'name',
    'status',
    'plannedDate',
    'releasedAt',
    'isHotfix',
  ]);

  if (Object.keys(changes).length) {
    await logActivity({
      actorId: auth.id,
      action: 'release.updated',
      entityType: 'RELEASE',
      entityId: ref.id,
      projectId: ref.projectId,
      releaseId: ref.id,
      meta: { changes },
    });
  }

  if (body.status && body.status !== before.status) {
    const members = await prisma.projectMember.findMany({
      where: { projectId: ref.projectId },
      select: { userId: true },
    });
    await notify({
      userIds: members.map((m) => m.userId),
      event: 'RELEASE_STATUS_CHANGED',
      title: `Release ${release.version} is now ${String(body.status).toLowerCase().replace('_', ' ')}`,
      body: `${auth.user.name} updated ${access.projectKey} release ${release.version}.`,
      url: `/projects/${access.projectKey}/releases/${release.id}`,
      actorId: auth.id,
      projectId: ref.projectId,
      releaseId: ref.id,
    });
  }

  res.json({ data: release });
};

export const deleteRelease = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  await auth.requireProject(ref.projectId, 'release:delete');
  await prisma.release.delete({ where: { id: ref.id } });
  await logActivity({
    actorId: auth.id,
    action: 'release.deleted',
    entityType: 'RELEASE',
    entityId: ref.id,
    projectId: ref.projectId,
    meta: { version: ref.version },
  });
  res.status(204).end();
};

/** Adds or removes tasks and issues from a release's scope. */
export const updateScope = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  await auth.requireProject(ref.projectId, 'release:update');
  const body = req.body as { taskIds?: string[]; issueIds?: string[]; mode: 'add' | 'remove' | 'set' };

  await prisma.$transaction(async (tx) => {
    if (body.mode === 'set') {
      await tx.task.updateMany({ where: { releaseId: ref.id }, data: { releaseId: null } });
      await tx.issue.updateMany({ where: { releaseId: ref.id }, data: { releaseId: null } });
    }
    const releaseId = body.mode === 'remove' ? null : ref.id;
    if (body.taskIds?.length) {
      await tx.task.updateMany({
        where: { id: { in: body.taskIds }, projectId: ref.projectId },
        data: { releaseId },
      });
    }
    if (body.issueIds?.length) {
      await tx.issue.updateMany({
        where: { id: { in: body.issueIds }, projectId: ref.projectId },
        data: { releaseId },
      });
    }
  });

  await logActivity({
    actorId: auth.id,
    action: 'release.scope_changed',
    entityType: 'RELEASE',
    entityId: ref.id,
    projectId: ref.projectId,
    releaseId: ref.id,
    meta: {
      mode: body.mode,
      tasks: body.taskIds?.length ?? 0,
      issues: body.issueIds?.length ?? 0,
    },
  });

  res.json({ ok: true });
};

/**
 * Records a deployment. Deploying to the production phase marks the release as
 * RELEASED and promotes every task in its scope to that phase.
 */
export const recordDeployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  const access = await auth.requireProject(ref.projectId, 'release:deploy');
  const body = req.body as {
    phaseId: string;
    status?: DeploymentStatus;
    notes?: string | null;
    deployedAt?: Date | null;
  };

  const phase = await prisma.projectPhase.findUnique({
    where: { id: body.phaseId },
    select: { id: true, projectId: true, name: true, order: true, isProduction: true },
  });
  if (!phase || phase.projectId !== ref.projectId) {
    throw badRequest('That phase is not part of this project');
  }

  const status = body.status ?? 'SUCCEEDED';
  const succeeded = status === 'SUCCEEDED';

  const deployment = await prisma.$transaction(async (tx) => {
    const created = await tx.deployment.create({
      data: {
        releaseId: ref.id,
        phaseId: phase.id,
        status,
        notes: body.notes ?? null,
        ...(body.deployedAt ? { deployedAt: body.deployedAt } : {}),
        deployedById: auth.id,
      },
      select: {
        id: true,
        status: true,
        notes: true,
        deployedAt: true,
        phase: { select: phaseSummary },
        deployedBy: { select: userSummary },
      },
    });

    if (succeeded) {
      const current = await tx.release.findUniqueOrThrow({
        where: { id: ref.id },
        select: { phase: { select: { order: true } }, status: true, releasedAt: true },
      });
      const isForward = (current.phase?.order ?? -1) < phase.order;

      await tx.release.update({
        where: { id: ref.id },
        data: {
          ...(isForward ? { phaseId: phase.id } : {}),
          ...(phase.isProduction
            ? { status: 'RELEASED', releasedAt: current.releasedAt ?? new Date() }
            : current.status === 'PLANNED'
              ? { status: 'IN_DEVELOPMENT' }
              : {}),
        },
      });

      // Everything shipped in this release has now reached that environment.
      await tx.task.updateMany({
        where: { releaseId: ref.id },
        data: { phaseId: phase.id },
      });
    }

    return created;
  });

  await logActivity({
    actorId: auth.id,
    action: 'release.deployed',
    entityType: 'RELEASE',
    entityId: ref.id,
    projectId: ref.projectId,
    releaseId: ref.id,
    meta: { phase: phase.name, status, notes: body.notes ?? null },
  });

  const members = await prisma.projectMember.findMany({
    where: { projectId: ref.projectId },
    select: { userId: true },
  });

  await notify({
    userIds: members.map((m) => m.userId),
    event: 'DEPLOYMENT_RECORDED',
    title: `${ref.version} deployed to ${phase.name}${succeeded ? '' : ` (${status.toLowerCase()})`}`,
    body: `${auth.user.name} recorded a deployment of ${access.projectKey} ${ref.version} to ${phase.name}.${body.notes ? ` ${body.notes}` : ''}`,
    url: `/projects/${access.projectKey}/releases/${ref.id}`,
    actorId: auth.id,
    projectId: ref.projectId,
    releaseId: ref.id,
  });

  res.status(201).json({ data: deployment });
};

export const deleteDeployment = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const ref = await findReleaseRef(String(req.params.releaseId));
  await auth.requireProject(ref.projectId, 'release:deploy');
  const deploymentId = String(req.params.deploymentId);
  const deployment = await prisma.deployment.findUnique({ where: { id: deploymentId } });
  if (!deployment || deployment.releaseId !== ref.id) throw notFound('Deployment not found');
  await prisma.deployment.delete({ where: { id: deploymentId } });
  res.status(204).end();
};

/** Phase-by-phase view: what is ready for UAT, in Pilot, live in Production. */
export const getPhaseBoard = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.query.projectId ?? ''), 'task:view');

  const [phases, tasks, issues] = await Promise.all([
    prisma.projectPhase.findMany({
      where: { projectId: access.projectId },
      orderBy: { order: 'asc' },
    }),
    prisma.task.findMany({
      where: { projectId: access.projectId, status: { category: { not: 'CANCELED' } } },
      select: {
        id: true,
        key: true,
        title: true,
        type: true,
        priority: true,
        qaStatus: true,
        phaseId: true,
        dueDate: true,
        status: { select: { id: true, name: true, category: true, color: true } },
        release: { select: { id: true, version: true } },
        assignees: { select: { user: { select: userSummary } } },
      },
      take: 1000,
    }),
    prisma.issue.groupBy({
      by: ['phaseId', 'severity'],
      where: {
        projectId: access.projectId,
        status: { notIn: ['CLOSED', 'RESOLVED', 'WONT_FIX'] },
      },
      _count: { _all: true },
    }),
  ]);

  const byPhase = new Map<string, typeof tasks>();
  const unphased: typeof tasks = [];
  for (const task of tasks) {
    if (!task.phaseId) {
      unphased.push(task);
      continue;
    }
    if (!byPhase.has(task.phaseId)) byPhase.set(task.phaseId, []);
    byPhase.get(task.phaseId)!.push(task);
  }

  const issueCounts = new Map<string, { open: number; critical: number }>();
  for (const row of issues) {
    const key = row.phaseId ?? 'none';
    const entry = issueCounts.get(key) ?? { open: 0, critical: 0 };
    entry.open += row._count._all;
    if (row.severity === 'CRITICAL' || row.severity === 'BLOCKER') {
      entry.critical += row._count._all;
    }
    issueCounts.set(key, entry);
  }

  const mapTask = (t: (typeof tasks)[number]) => ({
    ...t,
    assignees: t.assignees.map((a) => a.user),
  });

  res.json({
    data: {
      phases: phases.map((phase) => {
        const phaseTasks = byPhase.get(phase.id) ?? [];
        return {
          phase,
          tasks: phaseTasks.map(mapTask),
          stats: {
            total: phaseTasks.length,
            done: phaseTasks.filter((t) => t.status.category === 'DONE').length,
            qaPassed: phaseTasks.filter((t) => t.qaStatus === 'PASSED').length,
            qaFailed: phaseTasks.filter((t) => t.qaStatus === 'FAILED').length,
            awaitingTesting: phaseTasks.filter(
              (t) => t.qaStatus === 'PENDING' || t.qaStatus === 'IN_TESTING',
            ).length,
            openIssues: issueCounts.get(phase.id)?.open ?? 0,
            criticalIssues: issueCounts.get(phase.id)?.critical ?? 0,
          },
        };
      }),
      unphased: unphased.map(mapTask),
    },
  });
};
