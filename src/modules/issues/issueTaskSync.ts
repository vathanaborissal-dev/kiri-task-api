/**
 * Keeps a task's status and its issue's status in step.
 *
 * A task raised to fix an issue is not independent of it: you cannot start work
 * on something that was closed last week, and an issue whose every task is done
 * should not still be sitting in In Progress waiting for somebody to remember.
 *
 * The coupling runs in both directions:
 *
 *  - **Issue gates task.** While the issue is settled (resolved, closed or
 *    won't fix) its tasks are frozen; they can be cancelled or finished, but
 *    not pushed back into active work. The caller is told to reopen the issue.
 *
 *  - **Task advances issue.** The first task to start moves the issue to In
 *    Progress; the last task to finish moves it to Ready for Testing. Neither
 *    step ever *closes* an issue — that stays a deliberate, permissioned act.
 *
 * The advance is best-effort by design: if it is not allowed by the workflow
 * table, or the issue has already moved on, nothing happens and the task change
 * still stands.
 */

import { conflict } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import type { Tx } from '../../lib/prisma.js';
import { logActivity } from '../../services/activity.js';
import { notify } from '../../services/notifications.js';
import type { IssueStatus, StatusCategory } from '../../generated/prisma/enums.js';
import { ISSUE_STATUS_LABEL, isSettled, transitionFor } from './issueWorkflow.js';

/** Categories that mean the task is no longer being worked on. */
const FINISHED: StatusCategory[] = ['DONE', 'CANCELED'];

export const isFinishedCategory = (category: StatusCategory) => FINISHED.includes(category);

type LinkedIssue = {
  id: string;
  key: string;
  title: string;
  status: IssueStatus;
  projectId: string;
  project: { key: string };
};

/** The issue a task is working towards, if any. */
export const issueForTask = async (taskId: string): Promise<LinkedIssue | null> => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      issue: {
        select: {
          id: true,
          key: true,
          title: true,
          status: true,
          projectId: true,
          project: { select: { key: true } },
        },
      },
    },
  });
  return task?.issue ?? null;
};

/**
 * Refuses a task status change that its issue does not permit.
 *
 * Only moves *into* active work are blocked. Finishing or cancelling a task on
 * a closed issue is housekeeping and stays allowed, otherwise tidying up after
 * a close would be impossible.
 */
export const assertTaskStatusAllowedByIssue = async (
  taskId: string,
  nextCategory: StatusCategory,
): Promise<void> => {
  if (isFinishedCategory(nextCategory)) return;

  const issue = await issueForTask(taskId);
  if (!issue || !isSettled(issue.status)) return;

  throw conflict(
    `${issue.key} is ${ISSUE_STATUS_LABEL[issue.status].toLowerCase()} — reopen it before putting its tasks back into progress.`,
    { issueKey: issue.key, issueStatus: issue.status },
  );
};

/** The same check for a batch of tasks, so bulk edits fail before they write. */
export const assertTasksStatusAllowedByIssue = async (
  taskIds: string[],
  nextCategory: StatusCategory,
): Promise<void> => {
  if (isFinishedCategory(nextCategory) || taskIds.length === 0) return;

  const blocked = await prisma.task.findMany({
    where: { id: { in: taskIds }, issue: { status: { in: ['RESOLVED', 'CLOSED', 'WONT_FIX'] } } },
    select: { key: true, issue: { select: { key: true, status: true } } },
    take: 5,
  });
  if (blocked.length === 0) return;

  const keys = blocked.map((task) => `${task.key} (${task.issue!.key})`).join(', ');
  throw conflict(
    `Some of these tasks belong to issues that are already settled — reopen the issue first: ${keys}.`,
  );
};

/**
 * Nudges an issue forward after one of its tasks changed status.
 *
 * Returns the new status when it moved, so the caller can mention it, or `null`
 * when nothing needed doing.
 */
export const advanceIssueFromTasks = async (
  taskId: string,
  actor: { id: string; name: string },
): Promise<{ key: string; from: IssueStatus; to: IssueStatus } | null> => {
  const issue = await issueForTask(taskId);
  if (!issue || isSettled(issue.status)) return null;

  const tasks = await prisma.task.findMany({
    where: { issueId: issue.id },
    select: { status: { select: { category: true } } },
  });
  if (tasks.length === 0) return null;

  const categories = tasks.map((task) => task.status.category);
  const everyTaskFinished = categories.every(isFinishedCategory);
  const anyTaskStarted = categories.some(
    (category) => category === 'IN_PROGRESS' || category === 'IN_REVIEW',
  );

  const next: IssueStatus | null = everyTaskFinished
    ? 'READY_FOR_TESTING'
    : anyTaskStarted
      ? 'IN_PROGRESS'
      : null;

  // Only move when the workflow table agrees — an issue already in Ready for
  // Testing must not be dragged back to In Progress by a late task edit.
  if (!next || next === issue.status || !transitionFor(issue.status, next)) return null;

  await prisma.issue.update({ where: { id: issue.id }, data: { status: next } });

  await logActivity({
    actorId: actor.id,
    action: 'issue.status_changed',
    entityType: 'ISSUE',
    entityId: issue.id,
    projectId: issue.projectId,
    issueId: issue.id,
    meta: { statusFrom: issue.status, statusTo: next, via: 'task-progress' },
  });

  const audience = await prisma.issue
    .findUnique({
      where: { id: issue.id },
      select: {
        reporterId: true,
        assigneeId: true,
        watchers: { select: { userId: true } },
      },
    })
    .then((row) =>
      row
        ? [row.reporterId, ...(row.assigneeId ? [row.assigneeId] : []), ...row.watchers.map((w) => w.userId)]
        : [],
    );

  await notify({
    userIds: audience,
    event: 'ISSUE_STATUS_CHANGED',
    title: `${issue.key} → ${ISSUE_STATUS_LABEL[next]}`,
    body: `${actor.name} moved a task on “${issue.title}”, so the issue is now ${ISSUE_STATUS_LABEL[next]}.`,
    url: `/projects/${issue.project.key}/issues/${issue.key}`,
    actorId: actor.id,
    projectId: issue.projectId,
    issueId: issue.id,
  });

  return { key: issue.key, from: issue.status, to: next };
};

/**
 * Works out which status an issue's tasks should be moved to when the issue
 * itself moves, *before* the transaction opens.
 *
 * Split from the write deliberately. Every round trip inside an interactive
 * transaction is held against Prisma's five-second budget, and against a
 * database a region away that budget is spent quickly — these two reads inside
 * the transaction were enough to make a status change time out with a P2028
 * under load. They do not need to be in it: the worst case is that somebody
 * deletes the cancelled column in the microseconds in between, and the
 * `updateMany` then writes a status that no longer exists, which the foreign
 * key refuses.
 *
 * Returns `null` when there is nothing to do.
 */
export const planTaskSyncForIssueStatus = async (
  issueId: string,
  issueStatus: IssueStatus,
): Promise<{ statusId: string } | null> => {
  // Only dismissing an issue touches its tasks. Resolving one does not: the
  // fix may well be done while the tasks around it are not.
  if (issueStatus !== 'WONT_FIX') return null;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { projectId: true },
  });
  if (!issue) return null;

  const canceled = await prisma.taskStatus.findFirst({
    where: { projectId: issue.projectId, category: 'CANCELED' },
    orderBy: { order: 'asc' },
    select: { id: true },
  });
  // A project with no cancelled column leaves its tasks where they are rather
  // than inventing a status for them.
  return canceled ? { statusId: canceled.id } : null;
};

/**
 * Applies the plan. One statement, so it costs the transaction a single round
 * trip.
 */
export const syncTasksToIssueStatus = async (
  tx: Tx,
  issueId: string,
  plan: { statusId: string } | null,
): Promise<number> => {
  if (!plan) return 0;
  const result = await tx.task.updateMany({
    where: { issueId, status: { category: { notIn: ['DONE', 'CANCELED'] } } },
    data: { statusId: plan.statusId },
  });
  return result.count;
};
