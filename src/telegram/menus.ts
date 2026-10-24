import { InlineKeyboard } from 'grammy';
import { formatDate } from '../lib/dates.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';
import type { AuthContext } from '../services/authContext.js';
import * as fmt from './format.js';

/**
 * The card for one piece of work, plus the buttons that act on it.
 *
 * Built in one place so that acting on an item can redraw it. Tapping "Done"
 * used to leave the card showing the old status with a "Done" button still
 * under it — the work had moved but the message had not, so the only way to
 * know it worked was the toast that had already gone.
 */

export type Menu = { text: string; reply_markup: InlineKeyboard };

/** A status change only shows up if the card is redrawn with it. */
const DESCRIPTION_LIMIT = 400;

const describe = (value: string | null): string | null =>
  value?.trim()
    ? `\n${fmt.esc(value.trim().slice(0, DESCRIPTION_LIMIT))}${value.trim().length > DESCRIPTION_LIMIT ? fmt.esc('…') : ''}`
    : null;

export const taskMenu = async (auth: AuthContext, taskId: string): Promise<Menu> => {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      priority: true,
      dueDate: true,
      qaStatus: true,
      projectId: true,
      status: { select: { name: true, category: true } },
      phase: { select: { name: true } },
      project: { select: { key: true } },
      assignees: { select: { user: { select: { name: true } } } },
      _count: { select: { subtasks: true, comments: true } },
    },
  });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found');
  await auth.requireProject(task.projectId, 'task:view');

  const done = task.status.category === 'DONE' || task.status.category === 'CANCELED';
  const overdue = task.dueDate && !done && task.dueDate < new Date();

  const text = [
    `${fmt.PRIORITY_ICON[task.priority] ?? '•'} *${fmt.esc(task.key)}* ${fmt.esc(task.title)}`,
    '',
    `Status: ${fmt.CATEGORY_ICON[task.status.category] ?? '•'} ${fmt.esc(task.status.name)}`,
    task.phase ? `Phase: ${fmt.esc(task.phase.name)}` : null,
    `Testing: ${fmt.esc(task.qaStatus.replace(/_/g, ' ').toLowerCase())}`,
    task.dueDate
      ? `Due: ${overdue ? '⚠️ ' : ''}${fmt.esc(formatDate(task.dueDate, auth.user.timezone))}`
      : null,
    task.assignees.length
      ? `Assigned: ${fmt.esc(task.assignees.map((a) => a.user.name).join(', '))}`
      : 'Unassigned',
    task._count.subtasks ? `Subtasks: ${task._count.subtasks}` : null,
    task._count.comments ? `Comments: ${task._count.comments}` : null,
    describe(task.description),
  ]
    .filter((line) => line !== null)
    .join('\n');

  // Offering "Done" on something already done is an invitation to a no-op, and
  // offering nothing at all strands the card — so finished work can be reopened.
  const keyboard = new InlineKeyboard();
  if (done) keyboard.text('↩️ Reopen', `task:start:${task.id}`);
  else keyboard.text('▶️ In progress', `task:start:${task.id}`).text('✅ Done', `task:done:${task.id}`);
  keyboard.row().text('💬 Comment', `task:comment:${task.id}`);

  return {
    text,
    reply_markup: fmt.addOpenButton(
      keyboard,
      'Open in Kiri Task',
      `/projects/${task.project.key}/tasks/${task.key}`,
    ),
  };
};

export const issueMenu = async (auth: AuthContext, issueId: string): Promise<Menu> => {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      severity: true,
      status: true,
      startDate: true,
      dueDate: true,
      projectId: true,
      phase: { select: { name: true } },
      project: { select: { key: true } },
      assignee: { select: { name: true } },
      reporter: { select: { name: true } },
      _count: { select: { comments: true, attachments: true, tasks: true } },
    },
  });
  if (!issue) throw new AppError(404, 'NOT_FOUND', 'Issue not found');
  await auth.requireProject(issue.projectId, 'issue:view');

  // Anything already settled gets "Reopen" instead of a row of buttons that
  // would walk it forward from a state it has left.
  const settled =
    issue.status === 'RESOLVED' || issue.status === 'CLOSED' || issue.status === 'WONT_FIX';

  const text = [
    `${fmt.SEVERITY_ICON[issue.severity] ?? '•'} *${fmt.esc(issue.key)}* ${fmt.esc(issue.title)}`,
    '',
    `Status: ${fmt.esc(fmt.humanStatus(issue.status))}`,
    `Severity: ${fmt.esc(issue.severity.toLowerCase())}`,
    issue.phase ? `Environment: ${fmt.esc(issue.phase.name)}` : null,
    issue.startDate ? `Starts: ${fmt.esc(formatDate(issue.startDate, auth.user.timezone))}` : null,
    issue.dueDate ? `Due: ${fmt.esc(formatDate(issue.dueDate, auth.user.timezone))}` : null,
    `Reported by: ${fmt.esc(issue.reporter.name)}`,
    issue.assignee ? `Assigned: ${fmt.esc(issue.assignee.name)}` : 'Unassigned',
    issue._count.tasks ? `Tasks: ${issue._count.tasks}` : null,
    issue._count.attachments ? `Attachments: ${issue._count.attachments}` : null,
    describe(issue.description),
  ]
    .filter((line) => line !== null)
    .join('\n');

  const keyboard = new InlineKeyboard();
  if (settled) keyboard.text('↩️ Reopen', `issue:reopen:${issue.id}`);
  else {
    keyboard
      .text('▶️ Start', `issue:start:${issue.id}`)
      .text('🧪 Ready to test', `issue:testing:${issue.id}`)
      .row()
      .text('✅ Resolve', `issue:resolve:${issue.id}`);
  }
  keyboard.row().text('💬 Comment', `issue:comment:${issue.id}`);

  return {
    text,
    reply_markup: fmt.addOpenButton(
      keyboard,
      'Open in Kiri Task',
      `/projects/${issue.project.key}/issues/${issue.key}`,
    ),
  };
};

export const hotfixMenu = async (auth: AuthContext, hotfixId: string): Promise<Menu> => {
  const hotfix = await prisma.hotfix.findUnique({
    where: { id: hotfixId },
    select: {
      id: true,
      key: true,
      title: true,
      description: true,
      severity: true,
      status: true,
      projectId: true,
      approvedAt: true,
      project: { select: { key: true } },
      assignee: { select: { name: true } },
      requestedBy: { select: { name: true } },
    },
  });
  if (!hotfix) throw new AppError(404, 'NOT_FOUND', 'Hotfix not found');
  await auth.requireProject(hotfix.projectId, 'hotfix:view');

  const text = [
    `${fmt.SEVERITY_ICON[hotfix.severity] ?? '•'} *${fmt.esc(hotfix.key)}* ${fmt.esc(hotfix.title)}`,
    '',
    `Status: ${fmt.esc(fmt.humanStatus(hotfix.status))}`,
    `Severity: ${fmt.esc(hotfix.severity.toLowerCase())}`,
    `Requested by: ${fmt.esc(hotfix.requestedBy.name)}`,
    hotfix.assignee ? `Assigned: ${fmt.esc(hotfix.assignee.name)}` : 'Unassigned',
    describe(hotfix.description),
  ]
    .filter((line) => line !== null)
    .join('\n');

  // Approve and reject are offered only while the decision is still open, and
  // only to someone who may make it.
  const keyboard = new InlineKeyboard();
  if (hotfix.status === 'REQUESTED' && (await auth.canInProject(hotfix.projectId, 'hotfix:approve'))) {
    keyboard
      .text('✅ Approve', `hotfix:approve:${hotfix.id}`)
      .text('🚫 Reject', `hotfix:reject:${hotfix.id}`)
      .row();
  }

  return {
    text,
    reply_markup: fmt.addOpenButton(
      keyboard,
      'Open in Kiri Task',
      `/projects/${hotfix.project.key}/hotfixes/${hotfix.key}`,
    ),
  };
};

export const menuFor = (kind: 'task' | 'issue' | 'hotfix') =>
  kind === 'task' ? taskMenu : kind === 'issue' ? issueMenu : hotfixMenu;
