import {
  DEFAULT_LABELS,
  DEFAULT_PHASES,
  DEFAULT_TASK_STATUSES,
} from '../../config/projectDefaults.js';
import { prisma } from '../../lib/prisma.js';
import type { Tx } from '../../lib/prisma.js';

/** Creates the default board columns, lifecycle phases and labels. */
export const scaffoldProject = async (tx: Tx, projectId: string) => {
  await tx.taskStatus.createMany({
    data: DEFAULT_TASK_STATUSES.map((s, index) => ({
      projectId,
      key: s.key,
      name: s.name,
      category: s.category,
      color: s.color,
      order: index,
      isDefault: s.isDefault ?? false,
    })),
    skipDuplicates: true,
  });
  await tx.projectPhase.createMany({
    data: DEFAULT_PHASES.map((p, index) => ({
      projectId,
      key: p.key,
      name: p.name,
      description: p.description,
      color: p.color,
      order: index,
      isProduction: p.isProduction ?? false,
    })),
    skipDuplicates: true,
  });
  await tx.label.createMany({
    data: DEFAULT_LABELS.map((l) => ({ projectId, name: l.name, color: l.color })),
    skipDuplicates: true,
  });
};

/** Derives a unique project key from the name, e.g. "Kiri Drive" -> "KIRI". */
export const suggestProjectKey = async (name: string): Promise<string> => {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const base =
    words.length >= 2
      ? words.map((w) => w[0]).join('').slice(0, 4)
      : (words[0] ?? 'PRJ').slice(0, 4);

  let candidate = base || 'PRJ';
  let suffix = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.project.findUnique({ where: { key: candidate }, select: { id: true } })) {
    suffix += 1;
    candidate = `${base.slice(0, 3)}${suffix}`;
  }
  return candidate;
};

export const slugifyKey = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export type ProgressSummary = {
  totalTasks: number;
  doneTasks: number;
  openTasks: number;
  overdueTasks: number;
  blockedTasks: number;
  unassignedTasks: number;
  openIssues: number;
  criticalIssues: number;
  progress: number;
};

/** One grouped query per project list page, rather than N+1 counts. */
export const progressForProjects = async (
  projectIds: string[],
): Promise<Map<string, ProgressSummary>> => {
  const summaries = new Map<string, ProgressSummary>();
  if (projectIds.length === 0) return summaries;

  for (const id of projectIds) {
    summaries.set(id, {
      totalTasks: 0,
      doneTasks: 0,
      openTasks: 0,
      overdueTasks: 0,
      blockedTasks: 0,
      unassignedTasks: 0,
      openIssues: 0,
      criticalIssues: 0,
      progress: 0,
    });
  }

  const now = new Date();
  const [tasks, issues] = await Promise.all([
    prisma.task.groupBy({
      by: ['projectId', 'statusId'],
      where: { projectId: { in: projectIds }, parentTaskId: null },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ['projectId', 'severity'],
      where: {
        projectId: { in: projectIds },
        status: { notIn: ['CLOSED', 'RESOLVED', 'WONT_FIX'] },
      },
      _count: { _all: true },
    }),
  ]);

  const statuses = await prisma.taskStatus.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true, category: true },
  });
  const categoryById = new Map(statuses.map((s) => [s.id, s.category]));

  for (const row of tasks) {
    const summary = summaries.get(row.projectId);
    if (!summary) continue;
    const count = row._count._all;
    const category = categoryById.get(row.statusId);
    summary.totalTasks += count;
    if (category === 'DONE') summary.doneTasks += count;
    else if (category === 'CANCELED') summary.totalTasks -= count;
    else summary.openTasks += count;
    if (category === 'BLOCKED') summary.blockedTasks += count;
  }

  for (const row of issues) {
    const summary = summaries.get(row.projectId);
    if (!summary) continue;
    summary.openIssues += row._count._all;
    if (row.severity === 'CRITICAL' || row.severity === 'BLOCKER') {
      summary.criticalIssues += row._count._all;
    }
  }

  const [overdue, unassigned] = await Promise.all([
    prisma.task.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        dueDate: { lt: now },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
      _count: { _all: true },
    }),
    prisma.task.groupBy({
      by: ['projectId'],
      where: {
        projectId: { in: projectIds },
        assignees: { none: {} },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
      _count: { _all: true },
    }),
  ]);

  for (const row of overdue) {
    const summary = summaries.get(row.projectId);
    if (summary) summary.overdueTasks = row._count._all;
  }
  for (const row of unassigned) {
    const summary = summaries.get(row.projectId);
    if (summary) summary.unassignedTasks = row._count._all;
  }

  for (const summary of summaries.values()) {
    summary.progress =
      summary.totalTasks > 0 ? Math.round((summary.doneTasks / summary.totalTasks) * 100) : 0;
  }

  return summaries;
};
