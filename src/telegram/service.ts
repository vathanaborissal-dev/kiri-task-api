import { prisma } from '../lib/prisma.js';
import { AuthContext } from '../services/authContext.js';
import { logActivity } from '../services/activity.js';
import { sha256 } from '../lib/crypto.js';

/** Resolves the Kiri Task account linked to a Telegram chat. */
export const authForChat = async (chatId: number | bigint): Promise<AuthContext | null> => {
  const user = await prisma.user.findUnique({
    where: { telegramChatId: BigInt(chatId) },
    select: { id: true },
  });
  if (!user) return null;
  return AuthContext.forUserId(user.id);
};

export const linkChat = async (
  code: string,
  chatId: number | bigint,
  username: string | undefined,
): Promise<{ ok: true; name: string } | { ok: false; reason: string }> => {
  const token = await prisma.telegramLinkToken.findUnique({
    where: { code: code.trim().toUpperCase() },
    include: { user: { select: { id: true, name: true, isActive: true } } },
  });

  if (!token || token.usedAt) return { ok: false, reason: 'That code is not valid any more.' };
  if (token.expiresAt < new Date()) return { ok: false, reason: 'That code has expired. Generate a new one from Settings → Telegram.' };
  if (!token.user.isActive) return { ok: false, reason: 'That account is not active.' };

  const existing = await prisma.user.findUnique({
    where: { telegramChatId: BigInt(chatId) },
    select: { id: true },
  });
  if (existing && existing.id !== token.userId) {
    return {
      ok: false,
      reason: 'This Telegram account is already connected to a different Kiri Task user. Disconnect it there first.',
    };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: token.userId },
      data: {
        telegramChatId: BigInt(chatId),
        telegramUsername: username ?? null,
        telegramLinkedAt: new Date(),
      },
    }),
    prisma.telegramLinkToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    }),
  ]);

  await logActivity({
    actorId: token.userId,
    action: 'telegram.linked',
    entityType: 'USER',
    entityId: token.userId,
    meta: { username: username ?? null },
  });

  return { ok: true, name: token.user.name };
};

export const unlinkChat = async (userId: string) => {
  await prisma.user.update({
    where: { id: userId },
    data: { telegramChatId: null, telegramUsername: null, telegramLinkedAt: null },
  });
  await logActivity({
    actorId: userId,
    action: 'telegram.unlinked',
    entityType: 'USER',
    entityId: userId,
  });
};

/** Hashing helper kept here so the webhook can verify Telegram's secret token. */
export const webhookSecretMatches = (provided: string | undefined, expected: string | undefined) =>
  Boolean(expected) && Boolean(provided) && sha256(provided!) === sha256(expected!);
