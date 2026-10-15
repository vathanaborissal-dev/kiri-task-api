import { env } from '../config/env.js';
import { notificationEmail, sendEmail } from '../lib/email.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { NotificationEvent } from '../generated/prisma/enums.js';
import { sendTelegramMessage, type TelegramButton } from './channels.js';
import { pushToUser } from './realtime.js';

export type NotifyInput = {
  userIds: string[];
  event: NotificationEvent;
  title: string;
  body?: string;
  /** Relative path inside the web app, e.g. `/projects/KIRI/tasks/KIRI-12`. */
  url?: string;
  actorId?: string | null;
  projectId?: string | null;
  taskId?: string | null;
  issueId?: string | null;
  releaseId?: string | null;
  hotfixId?: string | null;
  commentId?: string | null;
  /** Extra Telegram action buttons beyond the link back to the related item. */
  telegramButtons?: { text: string; callbackData: string }[][];
};

const EMAIL_BY_DEFAULT: NotificationEvent[] = ['MENTION', 'HOTFIX_REQUESTED'];

export const defaultSettingFor = (event: NotificationEvent) => ({
  web: true,
  telegram: true,
  email: EMAIL_BY_DEFAULT.includes(event),
});

const absoluteUrl = (path?: string) =>
  path ? `${env.WEB_APP_URL.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}` : undefined;

/** Telegram rejects localhost and private-network URLs in inline buttons. */
export const telegramButtonUrl = (link?: string) => {
  if (!link) return undefined;
  try {
    const { hostname, protocol } = new URL(link);
    const privateHost =
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.startsWith('127.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
    return !privateHost && (protocol === 'http:' || protocol === 'https:') ? link : undefined;
  } catch {
    return undefined;
  }
};

const telegramLinkLabel = (input: NotifyInput) => {
  if (input.taskId) return 'View task';
  if (input.issueId) return 'View issue';
  if (input.hotfixId) return 'View urgent fix';
  if (input.releaseId) return 'View release';
  if (input.projectId) return 'View project';
  return 'Open Kiri Task';
};

const telegramIcon = (event: NotificationEvent) => {
  if (event === 'MENTION') return '👤';
  if (event.endsWith('_COMMENT')) return '💬';
  if (event.endsWith('_ASSIGNED')) return '📌';
  if (event.endsWith('_UPDATED')) return '✏️';
  if (event.endsWith('_DELETED')) return '🗑️';
  if (event.includes('STATUS') || event.includes('PHASE')) return '🔄';
  if (event.includes('OVERDUE') || event.includes('DUE_SOON')) return '⏰';
  return '🔔';
};

const telegramFallbackButton = (input: NotifyInput): TelegramButton | undefined => {
  if (input.taskId) {
    return { text: 'View details', callbackData: `task:menu:${input.taskId}` };
  }
  if (input.issueId) {
    return { text: 'View details', callbackData: `issue:menu:${input.issueId}` };
  }
  return undefined;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Single entry point for every notification in the system. Fans out to the web
 * notification centre, Telegram and email according to each recipient's
 * per-event preferences, and never notifies the person who caused the event.
 */
export const notify = async (input: NotifyInput): Promise<void> => {
  const recipientIds = [...new Set(input.userIds)].filter(
    (id) => id && id !== input.actorId,
  );
  if (recipientIds.length === 0) return;

  try {
    const [recipients, settings] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: recipientIds }, isActive: true },
        select: {
          id: true,
          name: true,
          email: true,
          telegramChatId: true,
        },
      }),
      prisma.notificationSetting.findMany({
        where: { userId: { in: recipientIds }, event: input.event },
      }),
    ]);

    if (recipients.length === 0) return;

    const settingByUser = new Map(settings.map((s) => [s.userId, s]));
    const fallback = defaultSettingFor(input.event);
    const link = absoluteUrl(input.url);
    const telegramLink = telegramButtonUrl(link);

    const webRecipients = recipients.filter(
      (r) => (settingByUser.get(r.id) ?? fallback).web !== false,
    );

    if (webRecipients.length > 0) {
      await prisma.notification.createMany({
        data: webRecipients.map((r) => ({
          userId: r.id,
          event: input.event,
          title: input.title,
          body: input.body ?? null,
          url: input.url ?? null,
          actorId: input.actorId ?? null,
          projectId: input.projectId ?? null,
          taskId: input.taskId ?? null,
          issueId: input.issueId ?? null,
          releaseId: input.releaseId ?? null,
          hotfixId: input.hotfixId ?? null,
          commentId: input.commentId ?? null,
        })),
      });

      for (const r of webRecipients) {
        const unread = await prisma.notification.count({
          where: { userId: r.id, readAt: null },
        });
        pushToUser(r.id, { type: 'notification', payload: { title: input.title, body: input.body, url: input.url, event: input.event } });
        pushToUser(r.id, { type: 'unread', payload: { count: unread } });
      }
    }

    await Promise.all(
      recipients.map(async (r) => {
        const setting = settingByUser.get(r.id) ?? fallback;

        if (setting.telegram !== false && r.telegramChatId) {
          const buttons: TelegramButton[][] = [...(input.telegramButtons ?? [])];
          if (telegramLink) {
            // A Mini App keeps people inside Telegram; Telegram only accepts
            // one over https, so anything else stays an ordinary link.
            const text = telegramLinkLabel(input);
            buttons.push([
              telegramLink.startsWith('https://')
                ? { text, webApp: telegramLink }
                : { text, url: telegramLink },
            ]);
          } else {
            const fallback = telegramFallbackButton(input);
            if (fallback) buttons.push([fallback]);
          }
          await sendTelegramMessage({
            chatId: r.telegramChatId,
            text: `${telegramIcon(input.event)} *${escapeTelegram(input.title)}*${input.body ? `\n\n${escapeTelegram(input.body)}` : ''}`,
            buttons: buttons.length ? buttons : undefined,
          });
        }

        if (setting.email === true) {
          await sendEmail({
            to: [{ email: r.email, name: r.name }],
            subject: input.title,
            html: notificationEmail({
              title: escapeHtml(input.title),
              body: escapeHtml(input.body ?? ''),
              url: link,
            }),
          });
        }
      }),
    );
  } catch (error) {
    logger.error({ error, event: input.event }, 'Failed to deliver notifications');
  }
};

/** MarkdownV2 is unforgiving; escape everything that is not ours. */
export const escapeTelegram = (value: string) =>
  value.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
