import { prisma } from '../lib/prisma.js';
import { notify } from '../services/notifications.js';
import { formatDate } from '../lib/dates.js';

const OPEN_ISSUE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'READY_FOR_TESTING', 'REOPENED'] as const;

/**
 * Daily sweep: warn about work due in the next 24 hours and about anything
 * that has just slipped past its deadline.
 *
 * Reminder notifications are de-duplicated by looking for an identical
 * notification sent in the last 20 hours, so a restart cannot spam anybody.
 */
export const runDeadlineSweep = async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const dedupeSince = new Date(now.getTime() - 20 * 60 * 60 * 1000);

  const [dueSoon, overdue, dueIssues, milestones] = await Promise.all([
    prisma.task.findMany({
      where: {
        dueDate: { gte: now, lte: soon },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
        project: { archivedAt: null },
      },
      select: {
        id: true,
        key: true,
        title: true,
        dueDate: true,
        projectId: true,
        project: { select: { key: true } },
        assignees: { select: { userId: true, user: { select: { timezone: true } } } },
      },
    }),
    prisma.task.findMany({
      where: {
        dueDate: { lt: now, gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
        project: { archivedAt: null },
      },
      select: {
        id: true,
        key: true,
        title: true,
        dueDate: true,
        projectId: true,
        project: { select: { key: true } },
        assignees: { select: { userId: true, user: { select: { timezone: true } } } },
      },
    }),
    prisma.issue.findMany({
      where: {
        dueDate: { gte: now, lte: soon },
        status: { in: [...OPEN_ISSUE_STATUSES] },
        project: { archivedAt: null },
        assigneeId: { not: null },
      },
      select: {
        id: true,
        key: true,
        title: true,
        dueDate: true,
        projectId: true,
        assigneeId: true,
        project: { select: { key: true } },
      },
    }),
    prisma.milestone.findMany({
      where: {
        dueDate: { gte: now, lte: soon },
        completedAt: null,
        project: { archivedAt: null },
      },
      select: {
        id: true,
        name: true,
        dueDate: true,
        projectId: true,
        project: { select: { key: true, ownerId: true } },
      },
    }),
  ]);

  const alreadySent = async (userId: string, taskId: string | null, issueId: string | null, event: string) => {
    const existing = await prisma.notification.findFirst({
      where: {
        userId,
        event: event as 'TASK_DUE_SOON',
        createdAt: { gte: dedupeSince },
        ...(taskId ? { taskId } : {}),
        ...(issueId ? { issueId } : {}),
      },
      select: { id: true },
    });
    return existing !== null;
  };

  let sent = 0;

  for (const task of dueSoon) {
    for (const assignee of task.assignees) {
      if (await alreadySent(assignee.userId, task.id, null, 'TASK_DUE_SOON')) continue;
      await notify({
        userIds: [assignee.userId],
        event: 'TASK_DUE_SOON',
        title: `⏰ ${task.key} is due ${formatDate(task.dueDate, assignee.user.timezone)}`,
        body: task.title,
        url: `/projects/${task.project.key}/tasks/${task.key}`,
        projectId: task.projectId,
        taskId: task.id,
        telegramButtons: [
          [
            { text: '▶️ In progress', callbackData: `task:start:${task.id}` },
            { text: '✅ Done', callbackData: `task:done:${task.id}` },
          ],
        ],
      });
      sent += 1;
    }
  }

  for (const task of overdue) {
    for (const assignee of task.assignees) {
      if (await alreadySent(assignee.userId, task.id, null, 'TASK_OVERDUE')) continue;
      await notify({
        userIds: [assignee.userId],
        event: 'TASK_OVERDUE',
        title: `⚠️ ${task.key} is overdue`,
        body: `${task.title} — was due ${formatDate(task.dueDate, assignee.user.timezone)}.`,
        url: `/projects/${task.project.key}/tasks/${task.key}`,
        projectId: task.projectId,
        taskId: task.id,
        telegramButtons: [
          [
            { text: '▶️ In progress', callbackData: `task:start:${task.id}` },
            { text: '✅ Done', callbackData: `task:done:${task.id}` },
          ],
        ],
      });
      sent += 1;
    }
  }

  for (const issue of dueIssues) {
    if (!issue.assigneeId) continue;
    if (await alreadySent(issue.assigneeId, null, issue.id, 'TASK_DUE_SOON')) continue;
    await notify({
      userIds: [issue.assigneeId],
      event: 'TASK_DUE_SOON',
      title: `⏰ ${issue.key} is due soon`,
      body: issue.title,
      url: `/projects/${issue.project.key}/issues/${issue.key}`,
      projectId: issue.projectId,
      issueId: issue.id,
    });
    sent += 1;
  }

  for (const milestone of milestones) {
    const members = await prisma.projectMember.findMany({
      where: { projectId: milestone.projectId },
      select: { userId: true },
    });
    await notify({
      userIds: [...members.map((m) => m.userId), milestone.project.ownerId],
      event: 'MILESTONE_DUE_SOON',
      title: `📍 Milestone “${milestone.name}” is due soon`,
      body: `Due ${formatDate(milestone.dueDate)}.`,
      url: `/projects/${milestone.project.key}`,
      projectId: milestone.projectId,
    });
    sent += 1;
  }

  return {
    dueSoonTasks: dueSoon.length,
    overdueTasks: overdue.length,
    dueIssues: dueIssues.length,
    milestones: milestones.length,
    notificationsSent: sent,
  };
};
