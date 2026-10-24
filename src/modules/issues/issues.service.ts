import { prisma } from '../../lib/prisma.js';
import { labelSummary, phaseSummary, statusSummary, userSummary } from '../shared/selectors.js';
import { notFound } from '../../lib/errors.js';
import { ISSUE_STATUS_LABEL } from './issueWorkflow.js';

export const issueListSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  severity: true,
  priority: true,
  startDate: true,
  dueDate: true,
  resolvedAt: true,
  closedAt: true,
  reopenCount: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, key: true, name: true, color: true } },
  phase: { select: phaseSummary },
  reporter: { select: userSummary },
  assignee: { select: userSummary },
  task: { select: { id: true, key: true, title: true } },
  release: { select: { id: true, version: true } },
  labels: { select: { label: { select: labelSummary } } },
  _count: { select: { comments: true, attachments: true, hotfixes: true, tasks: true } },
} as const;

export const issueDetailSelect = {
  ...issueListSelect,
  description: true,
  stepsToReproduce: true,
  expectedResult: true,
  actualResult: true,
  watchers: { select: { user: { select: userSummary } } },
  // One issue, many tasks: the detail page lists them rather than showing a
  // single "fix task" link, which is all `task` used to give.
  tasks: {
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      priority: true,
      progress: true,
      startDate: true,
      dueDate: true,
      completedAt: true,
      status: { select: statusSummary },
      assignees: { select: { user: { select: userSummary } } },
    },
    orderBy: { position: 'asc' },
  },
  hotfixes: {
    select: { id: true, key: true, title: true, status: true, severity: true },
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
} as const;

type RawIssue = {
  labels?: { label: unknown }[];
  watchers?: { user: unknown }[];
  tasks?: { assignees?: { user: unknown }[]; [key: string]: unknown }[];
  _count?: Record<string, number>;
  [key: string]: unknown;
};

export const shapeIssue = <T extends RawIssue>(issue: T) => {
  const { labels, watchers, tasks, _count, ...rest } = issue;
  const shapedTasks = (tasks ?? []).map((task) => ({
    ...task,
    assignees: (task.assignees ?? []).map((a) => a.user),
  }));

  return {
    ...rest,
    labels: (labels ?? []).map((l) => l.label),
    ...(watchers ? { watchers: watchers.map((w) => w.user) } : {}),
    ...(tasks ? { tasks: shapedTasks, taskProgress: rollUpTaskProgress(shapedTasks) } : {}),
    counts: {
      comments: _count?.comments ?? 0,
      attachments: _count?.attachments ?? 0,
      hotfixes: _count?.hotfixes ?? 0,
      tasks: _count?.tasks ?? (tasks?.length ?? 0),
    },
  };
};

type ShapedTask = { [key: string]: unknown };

const categoryOf = (task: ShapedTask): string | undefined =>
  (task.status as { category?: string } | null | undefined)?.category;

const progressOf = (task: ShapedTask): number =>
  typeof task.progress === 'number' ? task.progress : 0;

/**
 * How far along an issue is, taken from its tasks.
 *
 * A task's own percentage is used where it has one; a finished task counts as
 * 100 and a cancelled one is left out of the average entirely, so dropping a
 * task does not make the issue look like it went backwards.
 */
export const rollUpTaskProgress = (tasks: ShapedTask[]) => {
  const counted = tasks.filter((task) => categoryOf(task) !== 'CANCELED');
  if (counted.length === 0) return { percent: 0, done: 0, total: tasks.length };

  const done = counted.filter((task) => categoryOf(task) === 'DONE').length;
  const sum = counted.reduce(
    (total, task) => total + (categoryOf(task) === 'DONE' ? 100 : progressOf(task)),
    0,
  );
  return { percent: Math.round(sum / counted.length), done, total: counted.length };
};

export const findIssueRef = async (idOrKey: string) => {
  const issue = await prisma.issue.findFirst({
    where: { OR: [{ id: idOrKey }, { key: idOrKey.toUpperCase() }] },
    select: { id: true, projectId: true, key: true, project: { select: { key: true } } },
  });
  if (!issue) throw notFound('Issue not found');
  return issue;
};

export const issueAudience = async (issueId: string): Promise<string[]> => {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      reporterId: true,
      assigneeId: true,
      watchers: { select: { userId: true } },
    },
  });
  if (!issue) return [];
  return [
    issue.reporterId,
    ...(issue.assigneeId ? [issue.assigneeId] : []),
    ...issue.watchers.map((w) => w.userId),
  ];
};

/** Project members who should hear when a severe issue lands. */
export const projectEscalationAudience = async (projectId: string): Promise<string[]> => {
  const members = await prisma.projectMember.findMany({
    where: {
      projectId,
      role: {
        permissions: { hasSome: ['issue:assign', 'project:manage_members', 'hotfix:approve', '*'] },
      },
    },
    select: { userId: true },
  });
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { ownerId: true },
  });
  return [...members.map((m) => m.userId), ...(project ? [project.ownerId] : [])];
};

export const issueUrl = (projectKey: string, issueKey: string) =>
  `/projects/${projectKey}/issues/${issueKey}`;

export const SEVERITY_LABEL: Record<string, string> = {
  MINOR: 'Minor',
  MAJOR: 'Major',
  CRITICAL: 'Critical',
  BLOCKER: 'Blocker',
};

/**
 * Re-exported from the workflow module so the labels used in notifications and
 * the labels used in the transition table can never drift apart.
 */
export const STATUS_LABEL: Record<string, string> = ISSUE_STATUS_LABEL;
