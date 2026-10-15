import { badRequest, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import type { Tx } from '../../lib/prisma.js';
import { labelSummary, phaseSummary, statusSummary, userSummary } from '../shared/selectors.js';

export const taskListSelect = {
  id: true,
  key: true,
  title: true,
  type: true,
  priority: true,
  qaStatus: true,
  startDate: true,
  dueDate: true,
  completedAt: true,
  estimateHours: true,
  spentHours: true,
  position: true,
  createdAt: true,
  updatedAt: true,
  parentTaskId: true,
  project: { select: { id: true, key: true, name: true, color: true } },
  status: { select: statusSummary },
  phase: { select: phaseSummary },
  milestone: { select: { id: true, name: true } },
  release: { select: { id: true, version: true } },
  reporter: { select: userSummary },
  assignees: { select: { user: { select: userSummary } } },
  labels: { select: { label: { select: labelSummary } } },
  _count: { select: { subtasks: true, comments: true, attachments: true, checklist: true } },
} as const;

export const taskDetailSelect = {
  ...taskListSelect,
  description: true,
  parentTask: {
    select: {
      id: true,
      key: true,
      title: true,
      status: { select: statusSummary },
    },
  },
  subtasks: {
    select: {
      id: true,
      key: true,
      title: true,
      priority: true,
      dueDate: true,
      status: { select: statusSummary },
      assignees: { select: { user: { select: userSummary } } },
    },
    orderBy: { position: 'asc' },
  },
  checklist: {
    select: {
      id: true,
      title: true,
      isDone: true,
      order: true,
      dueDate: true,
      completedAt: true,
      assignee: { select: userSummary },
    },
    orderBy: { order: 'asc' },
  },
  watchers: { select: { user: { select: userSummary } } },
  linksFrom: {
    select: {
      id: true,
      type: true,
      target: {
        select: { id: true, key: true, title: true, status: { select: statusSummary } },
      },
    },
  },
  linksTo: {
    select: {
      id: true,
      type: true,
      source: {
        select: { id: true, key: true, title: true, status: { select: statusSummary } },
      },
    },
  },
  attachments: {
    select: {
      id: true,
      filename: true,
      url: true,
      mimeType: true,
      bytes: true,
      width: true,
      height: true,
      createdAt: true,
      uploadedBy: { select: userSummary },
    },
    orderBy: { createdAt: 'desc' },
  },
  // What is waiting on this task. The issue and hotfix views already show the
  // task they point at; without this the relationship is invisible from here.
  issues: {
    select: { id: true, key: true, title: true, status: true, severity: true },
    orderBy: { createdAt: 'desc' },
  },
  hotfixes: {
    select: { id: true, key: true, title: true, status: true, severity: true },
    orderBy: { createdAt: 'desc' },
  },
} as const;

type RawTask = {
  assignees?: { user: unknown }[];
  labels?: { label: unknown }[];
  watchers?: { user: unknown }[];
  _count?: Record<string, number>;
  [key: string]: unknown;
};

/** Flattens Prisma's join rows into the shape the UI consumes. */
export const shapeTask = <T extends RawTask>(task: T) => {
  const { assignees, labels, watchers, _count, ...rest } = task;
  return {
    ...rest,
    assignees: (assignees ?? []).map((a) => a.user),
    labels: (labels ?? []).map((l) => l.label),
    ...(watchers ? { watchers: watchers.map((w) => w.user) } : {}),
    counts: {
      subtasks: _count?.subtasks ?? 0,
      comments: _count?.comments ?? 0,
      attachments: _count?.attachments ?? 0,
      checklist: _count?.checklist ?? 0,
    },
  };
};

/** Atomically bumps the project's task counter to build `KIRI-42`. */
export const nextTaskKey = async (tx: Tx, projectId: string): Promise<string> => {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { taskCounter: { increment: 1 } },
    select: { key: true, taskCounter: true },
  });
  return `${project.key}-${project.taskCounter}`;
};

export const nextIssueKey = async (tx: Tx, projectId: string): Promise<string> => {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { issueCounter: { increment: 1 } },
    select: { key: true, issueCounter: true },
  });
  return `${project.key}-I${project.issueCounter}`;
};

export const nextHotfixKey = async (tx: Tx, projectId: string): Promise<string> => {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { hotfixCounter: { increment: 1 } },
    select: { key: true, hotfixCounter: true },
  });
  return `${project.key}-HF${project.hotfixCounter}`;
};

/** Resolves a task by id or human key and returns its project for authorisation. */
export const findTaskRef = async (idOrKey: string) => {
  const task = await prisma.task.findFirst({
    where: { OR: [{ id: idOrKey }, { key: idOrKey.toUpperCase() }] },
    select: { id: true, projectId: true, key: true, project: { select: { key: true } } },
  });
  if (!task) throw notFound('Task not found');
  return task;
};

/** Validates that every referenced record belongs to the same project. */
export const assertProjectScope = async (
  projectId: string,
  refs: {
    statusId?: string | null;
    phaseId?: string | null;
    milestoneId?: string | null;
    releaseId?: string | null;
    labelIds?: string[];
    assigneeIds?: string[];
    parentTaskId?: string | null;
  },
) => {
  const checks: Promise<void>[] = [];

  if (refs.statusId) {
    checks.push(
      prisma.taskStatus
        .findUnique({ where: { id: refs.statusId }, select: { projectId: true } })
        .then((s) => {
          if (s?.projectId !== projectId) throw badRequest('That status is not part of this project');
        }),
    );
  }
  if (refs.phaseId) {
    checks.push(
      prisma.projectPhase
        .findUnique({ where: { id: refs.phaseId }, select: { projectId: true } })
        .then((p) => {
          if (p?.projectId !== projectId) throw badRequest('That phase is not part of this project');
        }),
    );
  }
  if (refs.milestoneId) {
    checks.push(
      prisma.milestone
        .findUnique({ where: { id: refs.milestoneId }, select: { projectId: true } })
        .then((m) => {
          if (m?.projectId !== projectId) {
            throw badRequest('That milestone is not part of this project');
          }
        }),
    );
  }
  if (refs.releaseId) {
    checks.push(
      prisma.release
        .findUnique({ where: { id: refs.releaseId }, select: { projectId: true } })
        .then((r) => {
          if (r?.projectId !== projectId) {
            throw badRequest('That release is not part of this project');
          }
        }),
    );
  }
  if (refs.parentTaskId) {
    checks.push(
      prisma.task
        .findUnique({ where: { id: refs.parentTaskId }, select: { projectId: true, parentTaskId: true } })
        .then((t) => {
          if (t?.projectId !== projectId) {
            throw badRequest('The parent task is not part of this project');
          }
          if (t.parentTaskId) throw badRequest('Subtasks cannot have their own subtasks');
        }),
    );
  }
  if (refs.labelIds?.length) {
    checks.push(
      prisma.label
        .findMany({ where: { id: { in: refs.labelIds } }, select: { projectId: true } })
        .then((labels) => {
          if (labels.length !== refs.labelIds!.length || labels.some((l) => l.projectId !== projectId)) {
            throw badRequest('One or more labels are not part of this project');
          }
        }),
    );
  }
  if (refs.assigneeIds?.length) {
    checks.push(
      prisma.projectMember
        .findMany({
          where: { projectId, userId: { in: refs.assigneeIds } },
          select: { userId: true },
        })
        .then((members) => {
          const found = new Set(members.map((m) => m.userId));
          const missing = refs.assigneeIds!.filter((id) => !found.has(id));
          if (missing.length) {
            throw badRequest('You can only assign work to members of this project', { missing });
          }
        }),
    );
  }

  await Promise.all(checks);
};

/** New tasks land at the top of their column. */
export const positionForTop = async (projectId: string, statusId: string): Promise<number> => {
  const first = await prisma.task.findFirst({
    where: { projectId, statusId },
    orderBy: { position: 'asc' },
    select: { position: true },
  });
  return (first?.position ?? 0) - 1000;
};

/** Mid-point positioning, so a move only ever writes one row. */
export const positionAfter = async (
  projectId: string,
  statusId: string,
  afterTaskId: string | null | undefined,
): Promise<number> => {
  if (!afterTaskId) return positionForTop(projectId, statusId);

  const anchor = await prisma.task.findUnique({
    where: { id: afterTaskId },
    select: { position: true, statusId: true, projectId: true },
  });
  if (!anchor || anchor.projectId !== projectId) {
    throw badRequest('Could not work out where to place that task');
  }

  const next = await prisma.task.findFirst({
    where: { projectId, statusId, position: { gt: anchor.position }, id: { not: afterTaskId } },
    orderBy: { position: 'asc' },
    select: { position: true },
  });

  return next ? (anchor.position + next.position) / 2 : anchor.position + 1000;
};

/** Everybody who should hear about a change to this task. */
export const taskAudience = async (taskId: string): Promise<string[]> => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      reporterId: true,
      assignees: { select: { userId: true } },
      watchers: { select: { userId: true } },
    },
  });
  if (!task) return [];
  return [
    task.reporterId,
    ...task.assignees.map((a) => a.userId),
    ...task.watchers.map((w) => w.userId),
  ];
};

export const taskUrl = (projectKey: string, taskKey: string) =>
  `/projects/${projectKey}/tasks/${taskKey}`;
