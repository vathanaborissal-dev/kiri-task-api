import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { randomCode } from '../../lib/crypto.js';
import { badRequest } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { getAuth } from '../../middleware/auth.js';
import { sendTelegramMessage } from '../../services/channels.js';
import { escapeTelegram } from '../../services/notifications.js';
import { telegramReceivingUpdates } from '../../telegram/bot.js';
import { unlinkChat } from '../../telegram/service.js';

const CODE_TTL_MINUTES = 10;

export const getStatus = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.id },
    select: { telegramChatId: true, telegramUsername: true, telegramLinkedAt: true },
  });

  res.json({
    data: {
      linked: user.telegramChatId !== null,
      username: user.telegramUsername,
      linkedAt: user.telegramLinkedAt,
      botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
      botConfigured: env.telegramEnabled,
      botRunning: telegramReceivingUpdates(),
    },
  });
};

/**
 * Issues a one-time code. The user proves ownership of both sides by sending
 * the code to the bot, so no Telegram id is ever accepted from the browser.
 */
export const createLinkCode = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!env.telegramEnabled) throw badRequest('The Telegram bot is not configured on this server');

  const code = randomCode(8);
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

  await prisma.$transaction([
    // Only one live code per person.
    prisma.telegramLinkToken.deleteMany({ where: { userId: auth.id, usedAt: null } }),
    prisma.telegramLinkToken.create({ data: { userId: auth.id, code, expiresAt } }),
  ]);

  const botUsername = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, '');

  res.status(201).json({
    data: {
      code,
      expiresAt,
      expiresInMinutes: CODE_TTL_MINUTES,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
      botUsername: botUsername ?? null,
    },
  });
};

export const unlink = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  await unlinkChat(auth.id);
  res.status(204).end();
};

export const sendTest = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.id },
    select: { telegramChatId: true },
  });
  if (!user.telegramChatId) throw badRequest('Connect your Telegram account first');

  await sendTelegramMessage({
    chatId: user.telegramChatId,
    text: `*${escapeTelegram('Kiri Task')}*\n${escapeTelegram('Your Telegram notifications are working.')}`,
  });

  res.json({ ok: true });
};
