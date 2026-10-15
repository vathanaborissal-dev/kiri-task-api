import type { Request, Response } from 'express';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { logActivity } from '../../services/activity.js';
import { slugifyKey } from './projects.service.js';

const uniqueKey = async (
  table: 'taskStatus' | 'projectPhase',
  projectId: string,
  name: string,
) => {
  const base = slugifyKey(name) || 'item';
  let candidate = base;
  let n = 1;
  for (;;) {
    const existing =
      table === 'taskStatus'
        ? await prisma.taskStatus.findUnique({
            where: { projectId_key: { projectId, key: candidate } },
            select: { id: true },
          })
        : await prisma.projectPhase.findUnique({
            where: { projectId_key: { projectId, key: candidate } },
            select: { id: true },
          });
    if (!existing) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
};

// --- Task statuses ---------------------------------------------------------

export const createStatus = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const body = req.body as {
    name: string;
    category: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'BLOCKED' | 'DONE' | 'CANCELED';
    color?: string;
    isDefault?: boolean;
  };

  const last = await prisma.taskStatus.findFirst({
    where: { projectId: access.projectId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const status = await prisma.$transaction(async (tx) => {
    if (body.isDefault) {
      await tx.taskStatus.updateMany({
        where: { projectId: access.projectId },
        data: { isDefault: false },
      });
    }
    return tx.taskStatus.create({
      data: {
        projectId: access.projectId,
        key: await uniqueKey('taskStatus', access.projectId, body.name),
        name: body.name,
        category: body.category,
        ...(body.color ? { color: body.color } : {}),
        isDefault: body.isDefault ?? false,
        order: (last?.order ?? -1) + 1,
      },
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.status_created',
    entityType: 'PROJECT',
    entityId: access.projectId,
    projectId: access.projectId,
    meta: { name: status.name },
  });

  res.status(201).json({ data: status });
};

export const updateStatus = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const statusId = String(req.params.statusId);
  const body = req.body as Record<string, unknown>;

  const existing = await prisma.taskStatus.findUnique({ where: { id: statusId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Status not found');

  const status = await prisma.$transaction(async (tx) => {
    if (body.isDefault === true) {
      await tx.taskStatus.updateMany({
        where: { projectId: access.projectId },
        data: { isDefault: false },
      });
    }
    return tx.taskStatus.update({ where: { id: statusId }, data: body });
  });

  res.json({ data: status });
};

export const deleteStatus = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const statusId = String(req.params.statusId);

  const [status, taskCount, remaining] = await Promise.all([
    prisma.taskStatus.findUnique({ where: { id: statusId } }),
    prisma.task.count({ where: { statusId } }),
    prisma.taskStatus.count({ where: { projectId: access.projectId } }),
  ]);

  if (!status || status.projectId !== access.projectId) throw notFound('Status not found');
  if (remaining <= 1) throw badRequest('A project needs at least one status');

  const moveToId = String((req.body as { moveToStatusId?: string })?.moveToStatusId ?? '');
  if (taskCount > 0) {
    if (!moveToId) {
      throw conflict(
        `${taskCount} ${taskCount === 1 ? 'task is' : 'tasks are'} in this status. Choose a status to move them to.`,
        { taskCount },
      );
    }
    const target = await prisma.taskStatus.findUnique({ where: { id: moveToId } });
    if (!target || target.projectId !== access.projectId) {
      throw badRequest('Choose a status from this project');
    }
    await prisma.task.updateMany({ where: { statusId }, data: { statusId: moveToId } });
  }

  await prisma.taskStatus.delete({ where: { id: statusId } });
  if (status.isDefault) {
    const next = await prisma.taskStatus.findFirst({
      where: { projectId: access.projectId },
      orderBy: { order: 'asc' },
    });
    if (next) await prisma.taskStatus.update({ where: { id: next.id }, data: { isDefault: true } });
  }

  res.status(204).end();
};

export const reorderStatuses = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const { ids } = req.body as { ids: string[] };

  const statuses = await prisma.taskStatus.findMany({
    where: { projectId: access.projectId },
    select: { id: true },
  });
  const valid = new Set(statuses.map((s) => s.id));
  if (ids.some((id) => !valid.has(id))) throw badRequest('Unknown status in the new order');

  await prisma.$transaction(
    ids.map((id, order) => prisma.taskStatus.update({ where: { id }, data: { order } })),
  );

  res.json({ ok: true });
};

// --- Phases ----------------------------------------------------------------

export const createPhase = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const body = req.body as {
    name: string;
    description?: string | null;
    color?: string;
    isProduction?: boolean;
  };

  const last = await prisma.projectPhase.findFirst({
    where: { projectId: access.projectId },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  const phase = await prisma.$transaction(async (tx) => {
    if (body.isProduction) {
      await tx.projectPhase.updateMany({
        where: { projectId: access.projectId },
        data: { isProduction: false },
      });
    }
    return tx.projectPhase.create({
      data: {
        projectId: access.projectId,
        key: await uniqueKey('projectPhase', access.projectId, body.name),
        name: body.name,
        description: body.description ?? null,
        ...(body.color ? { color: body.color } : {}),
        isProduction: body.isProduction ?? false,
        order: (last?.order ?? -1) + 1,
      },
    });
  });

  await logActivity({
    actorId: auth.id,
    action: 'project.phase_created',
    entityType: 'PROJECT',
    entityId: access.projectId,
    projectId: access.projectId,
    meta: { name: phase.name },
  });

  res.status(201).json({ data: phase });
};

export const updatePhase = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const phaseId = String(req.params.phaseId);
  const body = req.body as Record<string, unknown>;

  const existing = await prisma.projectPhase.findUnique({ where: { id: phaseId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Phase not found');

  const phase = await prisma.$transaction(async (tx) => {
    if (body.isProduction === true) {
      await tx.projectPhase.updateMany({
        where: { projectId: access.projectId },
        data: { isProduction: false },
      });
    }
    return tx.projectPhase.update({ where: { id: phaseId }, data: body });
  });

  res.json({ data: phase });
};

export const deletePhase = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const phaseId = String(req.params.phaseId);

  const phase = await prisma.projectPhase.findUnique({
    where: { id: phaseId },
    include: { _count: { select: { tasks: true, issues: true, releases: true, deployments: true } } },
  });
  if (!phase || phase.projectId !== access.projectId) throw notFound('Phase not found');

  const inUse =
    phase._count.tasks + phase._count.issues + phase._count.releases + phase._count.deployments;
  if (inUse > 0) {
    throw conflict(
      `This phase is still referenced by ${inUse} ${inUse === 1 ? 'item' : 'items'}. Move them first.`,
    );
  }

  await prisma.projectPhase.delete({ where: { id: phaseId } });
  res.status(204).end();
};

export const reorderPhases = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const { ids } = req.body as { ids: string[] };

  const phases = await prisma.projectPhase.findMany({
    where: { projectId: access.projectId },
    select: { id: true },
  });
  const valid = new Set(phases.map((p) => p.id));
  if (ids.some((id) => !valid.has(id))) throw badRequest('Unknown phase in the new order');

  await prisma.$transaction(
    ids.map((id, order) => prisma.projectPhase.update({ where: { id }, data: { order } })),
  );
  res.json({ ok: true });
};

// --- Labels ----------------------------------------------------------------

export const createLabel = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const body = req.body as { name: string; color?: string };
  const label = await prisma.label.create({
    data: {
      projectId: access.projectId,
      name: body.name,
      ...(body.color ? { color: body.color } : {}),
    },
  });
  res.status(201).json({ data: label });
};

export const updateLabel = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const labelId = String(req.params.labelId);
  const existing = await prisma.label.findUnique({ where: { id: labelId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Label not found');
  const label = await prisma.label.update({
    where: { id: labelId },
    data: req.body as Record<string, unknown>,
  });
  res.json({ data: label });
};

export const deleteLabel = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const labelId = String(req.params.labelId);
  const existing = await prisma.label.findUnique({ where: { id: labelId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Label not found');
  await prisma.label.delete({ where: { id: labelId } });
  res.status(204).end();
};

// --- Milestones ------------------------------------------------------------

export const listMilestones = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'project:view');
  const milestones = await prisma.milestone.findMany({
    where: { projectId: access.projectId },
    orderBy: [{ dueDate: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { tasks: true } } },
  });

  const done = await prisma.task.groupBy({
    by: ['milestoneId'],
    where: {
      projectId: access.projectId,
      milestoneId: { not: null },
      status: { category: 'DONE' },
    },
    _count: { _all: true },
  });
  const doneByMilestone = new Map(done.map((d) => [d.milestoneId, d._count._all]));

  res.json({
    data: milestones.map(({ _count, ...m }) => ({
      ...m,
      taskCount: _count.tasks,
      doneTaskCount: doneByMilestone.get(m.id) ?? 0,
    })),
  });
};

export const createMilestone = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const body = req.body as { name: string; description?: string | null; dueDate?: Date | null };
  const milestone = await prisma.milestone.create({
    data: {
      projectId: access.projectId,
      name: body.name,
      description: body.description ?? null,
      ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
    },
  });
  await logActivity({
    actorId: auth.id,
    action: 'project.milestone_created',
    entityType: 'MILESTONE',
    entityId: milestone.id,
    projectId: access.projectId,
    meta: { name: milestone.name },
  });
  res.status(201).json({ data: milestone });
};

export const updateMilestone = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const milestoneId = String(req.params.milestoneId);
  const existing = await prisma.milestone.findUnique({ where: { id: milestoneId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Milestone not found');

  const body = req.body as Record<string, unknown> & { completed?: boolean };
  const { completed, ...rest } = body;
  const milestone = await prisma.milestone.update({
    where: { id: milestoneId },
    data: {
      ...rest,
      ...(completed === undefined ? {} : { completedAt: completed ? new Date() : null }),
    },
  });
  res.json({ data: milestone });
};

export const deleteMilestone = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(
    String(req.params.projectId),
    'project:manage_settings',
  );
  const milestoneId = String(req.params.milestoneId);
  const existing = await prisma.milestone.findUnique({ where: { id: milestoneId } });
  if (!existing || existing.projectId !== access.projectId) throw notFound('Milestone not found');
  await prisma.milestone.delete({ where: { id: milestoneId } });
  res.status(204).end();
};
