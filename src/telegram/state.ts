import { prisma } from '../lib/prisma.js';

/**
 * Per-chat conversation state for multi-step bot flows (reporting an issue,
 * adding a comment).
 *
 * Stored in the database rather than in the process. A draft is only worth
 * minutes, but it has to survive a redeploy: when this was a `Map`, restarting
 * the bot made it ignore the next message somebody sent without a word, so a
 * comment they had just typed simply vanished.
 */
export type PendingAction =
  | { kind: 'comment'; entity: 'task' | 'issue'; id: string }
  | { kind: 'report:project' }
  | { kind: 'report:title'; projectId: string }
  | {
      kind: 'report:details';
      projectId: string;
      title: string;
      description?: string;
      severity?: string;
    }
  | { kind: 'report:attachment'; issueId: string; projectId: string };

const TTL_MS = 15 * 60 * 1000;

export const setPending = async (chatId: number | bigint, action: PendingAction) => {
  const data = {
    action: action as unknown as object,
    expiresAt: new Date(Date.now() + TTL_MS),
  };
  await prisma.telegramPending.upsert({
    where: { chatId: BigInt(chatId) },
    update: data,
    create: { chatId: BigInt(chatId), ...data },
  });
};

export const getPending = async (chatId: number | bigint): Promise<PendingAction | null> => {
  const entry = await prisma.telegramPending.findUnique({ where: { chatId: BigInt(chatId) } });
  if (!entry) return null;

  if (entry.expiresAt.getTime() < Date.now()) {
    await clearPending(chatId);
    return null;
  }

  return entry.action as unknown as PendingAction;
};

export const clearPending = async (chatId: number | bigint) => {
  // `deleteMany` rather than `delete`: clearing a chat that has no draft is
  // the normal case — an expired comment, a /cancel typed out of habit — and
  // `delete` treats a missing row as a failure, logging a Prisma error each
  // time even though the caller swallows it.
  await prisma.telegramPending.deleteMany({ where: { chatId: BigInt(chatId) } });
};

/** Housekeeping, so abandoned drafts do not pile up. */
export const prunePending = async () => {
  await prisma.telegramPending.deleteMany({ where: { expiresAt: { lt: new Date() } } });
};
