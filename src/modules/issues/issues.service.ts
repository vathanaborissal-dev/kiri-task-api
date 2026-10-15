import { prisma } from '../../lib/prisma.js';
import { labelSummary, phaseSummary, userSummary } from '../shared/selectors.js';
import { notFound } from '../../lib/errors.js';

export const issueListSelect = {
  id: true,
  key: true,
  title: true,
  status: true,
  severity: true,
  priority: true,
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
  _count: { select: { comments: true, attachments: true, hotfixes: true } },
} as const;

export const issueDetailSelect = {
  ...issueListSelect,
  description: true,
  stepsToReproduce: true,
  expectedResult: true,
  actualResult: true,
  watchers: { select: { user: { select: userSummary } } },
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
  _count?: Record<string, number>;
  [key: string]: unknown;
};

export const shapeIssue = <T extends RawIssue>(issue: T) => {
  const { labels, watchers, _count, ...rest } = issue;
  return {
    ...rest,
    labels: (labels ?? []).map((l) => l.label),
    ...(watchers ? { watchers: watchers.map((w) => w.user) } : {}),
    counts: {
      comments: _count?.comments ?? 0,
      attachments: _count?.attachments ?? 0,
      hotfixes: _count?.hotfixes ?? 0,
    },
  };
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

export const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  READY_FOR_TESTING: 'Ready for Testing',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  WONT_FIX: "Won't Fix",
};
