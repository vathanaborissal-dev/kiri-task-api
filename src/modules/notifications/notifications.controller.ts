import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { paged, skipTake } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { defaultSettingFor } from '../../services/notifications.js';
import { addClient, removeClient } from '../../services/realtime.js';
import { NotificationEvent } from '../../generated/prisma/enums.js';
import { userSummary } from '../shared/selectors.js';

export const listNotifications = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const query = q<{ page: number; pageSize: number; unreadOnly: boolean }>(req);

  const where = { userId: auth.id, ...(query.unreadOnly ? { readAt: null } : {}) };

  const [notifications, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      ...skipTake(query),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        event: true,
        title: true,
        body: true,
        url: true,
        readAt: true,
        createdAt: true,
        actor: { select: userSummary },
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: auth.id, readAt: null } }),
  ]);

  res.json({ ...paged(notifications, total, query), unread });
};

export const markRead = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as { ids?: string[]; all?: boolean };

  if (body.all) {
    await prisma.notification.updateMany({
      where: { userId: auth.id, readAt: null },
      data: { readAt: new Date() },
    });
  } else if (body.ids?.length) {
    await prisma.notification.updateMany({
      where: { id: { in: body.ids }, userId: auth.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  const unread = await prisma.notification.count({ where: { userId: auth.id, readAt: null } });
  res.json({ unread });
};

export const markUnread = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  await prisma.notification.updateMany({
    where: { id: String(req.params.notificationId), userId: auth.id },
    data: { readAt: null },
  });
  const unread = await prisma.notification.count({ where: { userId: auth.id, readAt: null } });
  res.json({ unread });
};

export const clearRead = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const { count } = await prisma.notification.deleteMany({
    where: { userId: auth.id, readAt: { not: null } },
  });
  res.json({ deleted: count });
};

const EVENT_LABELS: Record<string, { label: string; description: string; group: string }> = {
  TASK_ASSIGNED: { label: 'Task assigned to me', description: 'Someone assigns a task to you.', group: 'Tasks' },
  TASK_UNASSIGNED: { label: 'Task unassigned', description: 'You are removed from a task.', group: 'Tasks' },
  TASK_UPDATED: { label: 'Assigned task edited', description: 'Someone changes a task assigned to you.', group: 'Tasks' },
  TASK_DELETED: { label: 'Assigned task deleted', description: 'Someone deletes a task assigned to you.', group: 'Tasks' },
  TASK_STATUS_CHANGED: { label: 'Task status changed', description: 'A task you follow moves column.', group: 'Tasks' },
  TASK_PHASE_CHANGED: { label: 'Task reaches a new phase', description: 'Work is promoted to UAT, Pilot or Production.', group: 'Tasks' },
  TASK_DUE_SOON: { label: 'Deadline approaching', description: 'A task is due within the next day.', group: 'Deadlines' },
  TASK_OVERDUE: { label: 'Task overdue', description: 'A task you own has passed its deadline.', group: 'Deadlines' },
  TASK_COMMENT: { label: 'New comment on a task', description: 'Somebody comments on a task you follow.', group: 'Collaboration' },
  ISSUE_REPORTED: { label: 'New issue reported', description: 'An issue is reported on your project.', group: 'Issues' },
  ISSUE_ASSIGNED: { label: 'Issue assigned to me', description: 'An issue is assigned to you.', group: 'Issues' },
  ISSUE_UPDATED: { label: 'Assigned issue edited', description: 'Someone changes an issue assigned to you.', group: 'Issues' },
  ISSUE_DELETED: { label: 'Assigned issue deleted', description: 'Someone deletes an issue assigned to you.', group: 'Issues' },
  ISSUE_STATUS_CHANGED: { label: 'Issue status changed', description: 'An issue you follow changes status.', group: 'Issues' },
  ISSUE_COMMENT: { label: 'New comment on an issue', description: 'Somebody comments on an issue you follow.', group: 'Collaboration' },
  MENTION: { label: 'I am mentioned', description: 'Someone @mentions you in a comment.', group: 'Collaboration' },
  HOTFIX_REQUESTED: { label: 'Hotfix requested', description: 'An urgent production fix is raised.', group: 'Releases' },
  HOTFIX_STATUS_CHANGED: { label: 'Hotfix progress', description: 'A hotfix is approved, tested or deployed.', group: 'Releases' },
  RELEASE_STATUS_CHANGED: { label: 'Release status changed', description: 'A release moves towards shipping.', group: 'Releases' },
  DEPLOYMENT_RECORDED: { label: 'Deployment recorded', description: 'A release is deployed to an environment.', group: 'Releases' },
  PROJECT_MEMBER_ADDED: { label: 'Added to a project', description: 'You are added to a project team.', group: 'Projects' },
  MILESTONE_DUE_SOON: { label: 'Milestone approaching', description: 'A milestone is due soon.', group: 'Deadlines' },
  STANDUP_BLOCKER: { label: 'Somebody is blocked', description: 'A person you oversee writes down something that is in their way.', group: 'Daily plans' },
};

export const getPreferences = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const stored = await prisma.notificationSetting.findMany({ where: { userId: auth.id } });
  const byEvent = new Map(stored.map((s) => [s.event, s]));

  const events = Object.values(NotificationEvent).map((event) => {
    const setting = byEvent.get(event) ?? { ...defaultSettingFor(event), id: null };
    const meta = EVENT_LABELS[event] ?? { label: event, description: '', group: 'Other' };
    return {
      event,
      ...meta,
      web: setting.web,
      telegram: setting.telegram,
      email: setting.email,
    };
  });

  res.json({
    data: events,
    telegramLinked: auth.user.telegramChatId !== null,
  });
};

export const updatePreferences = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    settings: { event: keyof typeof NotificationEvent; web?: boolean; telegram?: boolean; email?: boolean }[];
  };

  await prisma.$transaction(
    body.settings.map((setting) => {
      const fallback = defaultSettingFor(setting.event);
      return prisma.notificationSetting.upsert({
        where: { userId_event: { userId: auth.id, event: setting.event } },
        create: {
          userId: auth.id,
          event: setting.event,
          web: setting.web ?? fallback.web,
          telegram: setting.telegram ?? fallback.telegram,
          email: setting.email ?? fallback.email,
        },
        update: {
          ...(setting.web !== undefined ? { web: setting.web } : {}),
          ...(setting.telegram !== undefined ? { telegram: setting.telegram } : {}),
          ...(setting.email !== undefined ? { email: setting.email } : {}),
        },
      });
    }),
  );

  res.json({ ok: true });
};

/** Server-sent events: live notification badge and toasts. */
export const stream = (req: Request, res: Response) => {
  const auth = getAuth(req);
  const id = randomUUID();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  res.flushHeaders?.();

  addClient(id, auth.id, res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(id);
  });
};
