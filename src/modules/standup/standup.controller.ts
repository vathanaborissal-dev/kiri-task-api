import type { Request, Response } from 'express';
import type { DailyPlanItemKind } from '../../generated/prisma/enums.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { notify } from '../../services/notifications.js';
import { userSummary } from '../shared/selectors.js';
import {
  dayKeyIn,
  dateFromKey,
  ensurePlan,
  findItem,
  findPlan,
  keyFromDate,
  planSelect,
  shapePlan,
} from './standup.service.js';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A supplied calendar day when it is a sane one, otherwise today where the user is. */
const resolveDay = (raw: unknown, timezone: string): string => {
  if (typeof raw !== 'string' || raw.length === 0) return dayKeyIn(timezone);
  if (!DAY_KEY.test(raw) || Number.isNaN(dateFromKey(raw).getTime())) {
    throw badRequest('Use a date in YYYY-MM-DD form');
  }
  return raw;
};

export const getMyPlan = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const day = resolveDay(req.query.date, auth.user.timezone);
  const plan = (await findPlan(auth.id, day)) ?? (await ensurePlan(auth.id, day));
  res.json({ data: plan });
};

export const updateMyPlan = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as { date?: string; note?: string | null };
  const day = resolveDay(body.date, auth.user.timezone);

  await ensurePlan(auth.id, day);
  const plan = await prisma.dailyPlan.update({
    where: { userId_date: { userId: auth.id, date: dateFromKey(day) } },
    data: { note: body.note?.trim() ? body.note.trim() : null },
    select: planSelect,
  });

  res.json({ data: shapePlan(plan) });
};

/**
 * Who should hear that somebody is stuck: everyone holding `standup:view_team`,
 * either workspace-wide or on a project the author works in. A blocker nobody
 * is told about is just a note to yourself.
 */
const leadsFor = async (userId: string): Promise<string[]> => {
  const [globalRoles, memberships] = await Promise.all([
    prisma.role.findMany({
      where: { scope: 'GLOBAL', permissions: { hasSome: ['standup:view_team', '*'] } },
      select: { id: true },
    }),
    prisma.projectMember.findMany({ where: { userId }, select: { projectId: true } }),
  ]);

  const projectIds = memberships.map((m) => m.projectId);

  const [globalUsers, projectUsers] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, globalRoleId: { in: globalRoles.map((r) => r.id) } },
      select: { id: true },
    }),
    projectIds.length === 0
      ? Promise.resolve([])
      : prisma.projectMember.findMany({
          where: {
            projectId: { in: projectIds },
            role: { permissions: { hasSome: ['standup:view_team', '*'] } },
            user: { isActive: true },
          },
          select: { userId: true },
        }),
  ]);

  return [
    ...new Set([...globalUsers.map((u) => u.id), ...projectUsers.map((m) => m.userId)]),
  ].filter((id) => id !== userId);
};

export const addItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as {
    date?: string;
    kind?: DailyPlanItemKind;
    body: string;
    taskId?: string | null;
  };
  const day = resolveDay(body.date, auth.user.timezone);
  const kind: DailyPlanItemKind = body.kind ?? 'FOCUS';

  const plan = await ensurePlan(auth.id, day);

  // A bullet may point at a task, but only one the author can actually see.
  if (body.taskId) {
    const task = await prisma.task.findUnique({
      where: { id: body.taskId },
      select: { id: true, projectId: true },
    });
    if (!task) throw notFound('That task does not exist');
    if (!(await auth.canInProject(task.projectId, 'task:view'))) {
      throw notFound('That task does not exist');
    }
  }

  const last = await prisma.dailyPlanItem.findFirst({
    where: { planId: plan.id, kind },
    orderBy: { order: 'desc' },
    select: { order: true },
  });

  await prisma.dailyPlanItem.create({
    data: {
      planId: plan.id,
      kind,
      body: body.body.trim(),
      order: (last?.order ?? -1) + 1,
      taskId: body.taskId ?? null,
    },
  });

  if (kind === 'BLOCKER') {
    const recipients = await leadsFor(auth.id);
    await notify({
      userIds: recipients,
      event: 'STANDUP_BLOCKER',
      actorId: auth.id,
      title: `${auth.user.name} is blocked`,
      body: body.body.trim(),
      url: '/today/team',
    });
  }

  res.status(201).json({ data: await findPlan(auth.id, day) });
};

export const updateItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const itemId = String(req.params.itemId);
  const existing = await findItem(itemId);
  if (!existing) throw notFound('That bullet does not exist');
  // Your day is yours: nobody edits somebody else's plan, admin or not.
  if (existing.plan.userId !== auth.id) throw forbidden('You can only edit your own day');

  const body = req.body as {
    body?: string;
    kind?: DailyPlanItemKind;
    isDone?: boolean;
    resolved?: boolean;
  };

  await prisma.dailyPlanItem.update({
    where: { id: itemId },
    data: {
      ...(body.body !== undefined ? { body: body.body.trim() } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.isDone !== undefined ? { isDone: body.isDone } : {}),
      ...(body.resolved !== undefined ? { resolvedAt: body.resolved ? new Date() : null } : {}),
    },
  });

  res.json({ data: await findPlan(auth.id, keyFromDate(existing.plan.date)) });
};

export const deleteItem = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const itemId = String(req.params.itemId);
  const existing = await findItem(itemId);
  if (!existing) throw notFound('That bullet does not exist');
  if (existing.plan.userId !== auth.id) throw forbidden('You can only edit your own day');

  await prisma.dailyPlanItem.delete({ where: { id: itemId } });
  res.json({ data: await findPlan(auth.id, keyFromDate(existing.plan.date)) });
};

/** Reorders one kind's bullets inside a plan, in one transaction. */
export const reorderItems = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const body = req.body as { itemIds: string[] };

  const items = await prisma.dailyPlanItem.findMany({
    where: { id: { in: body.itemIds } },
    select: { id: true, planId: true, plan: { select: { userId: true, date: true } } },
  });

  if (items.length !== body.itemIds.length) throw notFound('Some of those bullets are gone');
  if (items.some((item) => item.plan.userId !== auth.id)) {
    throw forbidden('You can only edit your own day');
  }
  if (new Set(items.map((item) => item.planId)).size > 1) {
    throw badRequest('Those bullets are not all from the same day');
  }

  await prisma.$transaction(
    body.itemIds.map((id, order) =>
      prisma.dailyPlanItem.update({ where: { id }, data: { order } }),
    ),
  );

  res.json({ data: await findPlan(auth.id, keyFromDate(items[0]!.plan.date)) });
};

/**
 * Everyone this person is allowed to see, for one day. Members of projects
 * where they hold `standup:view_team`, plus the whole workspace when they hold
 * it globally. Always includes themselves, so the page is never empty.
 */
export const teamPlans = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const day = resolveDay(req.query.date, auth.user.timezone);

  let userIds: string[];

  if (auth.can('standup:view_team')) {
    const everyone = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    userIds = everyone.map((u) => u.id);
  } else {
    const projectIds = await auth.projectIdsWith('standup:view_team');
    if (projectIds.length === 0) throw forbidden("You cannot see other people's day");
    const members = await prisma.projectMember.findMany({
      where: { projectId: { in: projectIds }, user: { isActive: true } },
      select: { userId: true },
    });
    userIds = [...new Set([auth.id, ...members.map((m) => m.userId)])];
  }

  const [people, plans] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      orderBy: { name: 'asc' },
      select: userSummary,
    }),
    prisma.dailyPlan.findMany({
      where: { userId: { in: userIds }, date: dateFromKey(day) },
      select: planSelect,
    }),
  ]);

  const byUser = new Map(plans.map((plan) => [plan.user.id, shapePlan(plan)]));

  res.json({
    data: {
      date: day,
      // Everyone appears, with or without a plan — "nothing written down" is
      // itself worth seeing at a glance.
      people: people.map((person) => ({
        user: person,
        plan: byUser.get(person.id) ?? null,
      })),
    },
  });
};
