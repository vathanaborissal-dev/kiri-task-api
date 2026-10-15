import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { EntityType } from '../generated/prisma/enums.js';

export type ActivityInput = {
  actorId: string | null;
  action: string;
  entityType: EntityType;
  entityId: string;
  projectId?: string | null;
  taskId?: string | null;
  issueId?: string | null;
  releaseId?: string | null;
  hotfixId?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * Appends to the activity timeline. Deliberately fire-and-forget safe: a
 * failure to log must never fail the user's action.
 */
export const logActivity = async (input: ActivityInput): Promise<void> => {
  try {
    await prisma.activityLog.create({
      data: {
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        issueId: input.issueId ?? null,
        releaseId: input.releaseId ?? null,
        hotfixId: input.hotfixId ?? null,
        meta: (input.meta ?? {}) as object,
      },
    });
  } catch (error) {
    logger.warn({ error, action: input.action }, 'Failed to write activity log');
  }
};

export const logActivities = async (inputs: ActivityInput[]): Promise<void> => {
  if (inputs.length === 0) return;
  try {
    await prisma.activityLog.createMany({
      data: inputs.map((input) => ({
        actorId: input.actorId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        issueId: input.issueId ?? null,
        releaseId: input.releaseId ?? null,
        hotfixId: input.hotfixId ?? null,
        meta: (input.meta ?? {}) as object,
      })),
    });
  } catch (error) {
    logger.warn({ error }, 'Failed to write activity logs');
  }
};

/** Builds a `{ field: { from, to } }` map of what actually changed. */
export const diffFields = <T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: (keyof T)[],
): Record<string, { from: unknown; to: unknown }> => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = before[field];
    const to = after[field];
    const same =
      from instanceof Date && to instanceof Date
        ? from.getTime() === to.getTime()
        : JSON.stringify(from ?? null) === JSON.stringify(to ?? null);
    if (!same) changes[field as string] = { from: from ?? null, to: to ?? null };
  }
  return changes;
};
