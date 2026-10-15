import type { DailyPlanItemOrderByWithRelationInput } from '../../generated/prisma/models/DailyPlanItem.js';
import { prisma } from '../../lib/prisma.js';
import { taskRefSelect, userSummary } from '../shared/selectors.js';

/**
 * A daily plan is stored against a calendar date, not a timestamp, so "today"
 * means today where the author is sitting. Everything below converts between
 * the two in one place.
 */

/** The `YYYY-MM-DD` the given instant falls on in `timeZone`. */
export const dayKeyIn = (timeZone: string, at: Date = new Date()): string => {
  try {
    // en-CA formats as YYYY-MM-DD, which is exactly the key we store.
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(at);
  }
};

/** Postgres `date` columns round-trip as UTC midnight — build one from a key. */
export const dateFromKey = (key: string): Date => new Date(`${key}T00:00:00.000Z`);

export const keyFromDate = (value: Date): string => value.toISOString().slice(0, 10);

/** FOCUS before BLOCKER (the enum's own order), then as the author arranged them. */
const itemOrder: DailyPlanItemOrderByWithRelationInput[] = [
  { kind: 'asc' },
  { order: 'asc' },
  { createdAt: 'asc' },
];

export const planSelect = {
  id: true,
  date: true,
  note: true,
  updatedAt: true,
  user: { select: userSummary },
  items: {
    orderBy: itemOrder,
    select: {
      id: true,
      kind: true,
      body: true,
      isDone: true,
      resolvedAt: true,
      order: true,
      createdAt: true,
      task: { select: taskRefSelect },
    },
  },
} as const;

type StoredPlan = { date: Date };

/**
 * A Postgres `date` round-trips as midnight UTC, which would reach the client
 * as a timestamp it has to re-parse into a day. Hand out the day key instead.
 */
export const shapePlan = <T extends StoredPlan>(plan: T): Omit<T, 'date'> & { date: string } => ({
  ...plan,
  date: keyFromDate(plan.date),
});

/** The plan row for one person and day, created on demand. */
export const ensurePlan = async (userId: string, dayKey: string) => {
  const date = dateFromKey(dayKey);
  const plan = await prisma.dailyPlan.upsert({
    where: { userId_date: { userId, date } },
    update: {},
    create: { userId, date },
    select: planSelect,
  });
  return shapePlan(plan);
};

export const findPlan = async (userId: string, dayKey: string) => {
  const plan = await prisma.dailyPlan.findUnique({
    where: { userId_date: { userId, date: dateFromKey(dayKey) } },
    select: planSelect,
  });
  return plan ? shapePlan(plan) : null;
};

/** The item plus enough of its owner to authorise an edit. */
export const findItem = async (itemId: string) =>
  prisma.dailyPlanItem.findUnique({
    where: { id: itemId },
    select: {
      id: true,
      kind: true,
      body: true,
      planId: true,
      plan: { select: { userId: true, date: true } },
    },
  });
