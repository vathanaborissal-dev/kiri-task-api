import { type Bot, type Context, InlineKeyboard } from 'grammy';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type { AuthContext } from '../services/authContext.js';
import type { IssueStatus, Severity } from '../generated/prisma/enums.js';
import * as fmt from './format.js';
import { findByKey, parseItemKey, type ItemKind } from './lookup.js';
import { menuFor } from './menus.js';
import * as mut from './mutations.js';
import { authForChat } from './service.js';
import { clearPending, getPending, setPending } from './state.js';

const SEVERITY_CHOICES: { label: string; value: Severity }[] = [
  { label: '⛔️ Blocker', value: 'BLOCKER' },
  { label: '🔴 Critical', value: 'CRITICAL' },
  { label: '🟠 Major', value: 'MAJOR' },
  { label: '🟡 Minor', value: 'MINOR' },
];

const md = { parse_mode: 'MarkdownV2' as const, link_preview_options: { is_disabled: true } };

/** Turns a thrown AppError into a friendly Telegram reply. */
const guard = async (ctx: Context, fn: () => Promise<void>) => {
  try {
    await fn();
  } catch (error) {
    const message =
      error instanceof AppError ? error.message : 'Something went wrong. Please try the web app.';
    if (error instanceof AppError && error.status >= 500) {
      logger.error({ error }, 'Telegram action failed');
    } else if (!(error instanceof AppError)) {
      logger.error({ error }, 'Telegram action failed');
    }
    await ctx.answerCallbackQuery({ text: message, show_alert: true }).catch(() => undefined);
  }
};

const requireAuth = async (ctx: Context): Promise<AuthContext> => {
  const auth = await authForChat(ctx.chat!.id);
  if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Connect your account first with /start');
  return auth;
};

/** Sends the card for one item, with the buttons that act on it. */
const sendMenu = async (ctx: Context, auth: AuthContext, kind: ItemKind, id: string) => {
  const menu = await menuFor(kind)(auth, id);
  await ctx.reply(menu.text, { ...md, reply_markup: menu.reply_markup });
};

/**
 * Replaces the message a button lives on with the item as it now stands.
 *
 * Whatever the message was — a card, an overdue warning, a request for
 * approval — it was about this one item, and once somebody has acted the
 * buttons under it describe a state that has passed. Redrawing keeps the
 * message and its buttons honest; a toast that has already faded does not.
 *
 * Telegram refuses to edit a message older than 48 hours, and refuses an edit
 * that changes nothing, so a failure here is expected and silent.
 */
const refreshCard = async (ctx: Context, auth: AuthContext, kind: ItemKind, id: string) => {
  if (!ctx.callbackQuery?.message) return;
  try {
    const menu = await menuFor(kind)(auth, id);
    await ctx.editMessageText(menu.text, { ...md, reply_markup: menu.reply_markup });
  } catch {
    /* the toast already said what happened */
  }
};

export const registerActions = (bot: Bot) => {
  // --- Opening one item ----------------------------------------------------

  const menuAction = (kind: ItemKind) =>
    bot.callbackQuery(new RegExp(`^${kind}:menu:(.+)$`), async (ctx) =>
      guard(ctx, async () => {
        const auth = await requireAuth(ctx);
        await ctx.answerCallbackQuery();
        await sendMenu(ctx, auth, kind, ctx.match[1]!);
      }),
    );

  menuAction('task');
  menuAction('issue');
  menuAction('hotfix');

  // --- Task actions --------------------------------------------------------

  const taskStatusAction = (
    pattern: RegExp,
    category: 'IN_PROGRESS' | 'DONE',
    already: string,
  ) =>
    bot.callbackQuery(pattern, async (ctx) =>
      guard(ctx, async () => {
        const auth = await requireAuth(ctx);
        const taskId = ctx.match[1]!;
        const result = await mut.moveTaskToCategory(auth, taskId, category);
        await ctx.answerCallbackQuery({
          text: result.unchanged
            ? `${result.task.key} is already ${already}`
            : `${category === 'DONE' ? '✅ ' : ''}${result.task.key} → ${result.status.name}`,
        });
        await refreshCard(ctx, auth, 'task', taskId);
      }),
    );

  taskStatusAction(/^task:start:(.+)$/, 'IN_PROGRESS', 'in progress');
  taskStatusAction(/^task:done:(.+)$/, 'DONE', 'done');

  bot.callbackQuery(/^task:comment:(.+)$/, async (ctx) =>
    guard(ctx, async () => {
      const auth = await requireAuth(ctx);
      const taskId = ctx.match[1]!;
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        select: { key: true, projectId: true },
      });
      if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found');
      await auth.requireProject(task.projectId, 'task:view');

      await setPending(ctx.chat!.id, { kind: 'comment', entity: 'task', id: taskId });
      await ctx.answerCallbackQuery();
      await ctx.reply(`Send your comment for *${fmt.esc(task.key)}*, or /cancel to stop\\.`, md);
    }),
  );

  // --- Issue actions -------------------------------------------------------

  const issueStatusAction = (pattern: RegExp, status: IssueStatus, label: string) =>
    bot.callbackQuery(pattern, async (ctx) =>
      guard(ctx, async () => {
        const auth = await requireAuth(ctx);
        const issueId = ctx.match[1]!;
        const result = await mut.setIssueStatus(auth, issueId, status);
        await ctx.answerCallbackQuery({
          text: result.unchanged
            ? `${result.issue.key} is already ${label}`
            : `${result.issue.key} → ${label}`,
        });
        await refreshCard(ctx, auth, 'issue', issueId);
      }),
    );

  issueStatusAction(/^issue:start:(.+)$/, 'IN_PROGRESS', 'in progress');
  issueStatusAction(/^issue:testing:(.+)$/, 'READY_FOR_TESTING', 'ready for testing');
  issueStatusAction(/^issue:resolve:(.+)$/, 'RESOLVED', 'resolved');
  issueStatusAction(/^issue:reopen:(.+)$/, 'REOPENED', 'reopened');

  bot.callbackQuery(/^issue:comment:(.+)$/, async (ctx) =>
    guard(ctx, async () => {
      const auth = await requireAuth(ctx);
      const issueId = ctx.match[1]!;
      const issue = await prisma.issue.findUnique({
        where: { id: issueId },
        select: { key: true, projectId: true },
      });
      if (!issue) throw new AppError(404, 'NOT_FOUND', 'Issue not found');
      await auth.requireProject(issue.projectId, 'issue:view');

      await setPending(ctx.chat!.id, { kind: 'comment', entity: 'issue', id: issueId });
      await ctx.answerCallbackQuery();
      await ctx.reply(`Send your comment for *${fmt.esc(issue.key)}*, or /cancel to stop\\.`, md);
    }),
  );

  // --- Hotfix approval -----------------------------------------------------

  const hotfixDecision = (pattern: RegExp, approve: boolean) =>
    bot.callbackQuery(pattern, async (ctx) =>
      guard(ctx, async () => {
        const auth = await requireAuth(ctx);
        const hotfixId = ctx.match[1]!;
        const hotfix = await prisma.hotfix.findUnique({
          where: { id: hotfixId },
          select: {
            id: true,
            key: true,
            title: true,
            status: true,
            projectId: true,
            requestedById: true,
            assigneeId: true,
            project: { select: { key: true } },
          },
        });
        if (!hotfix) throw new AppError(404, 'NOT_FOUND', 'Hotfix not found');
        await auth.requireProject(hotfix.projectId, 'hotfix:approve');

        // Two people can be looking at the same approval request. Whoever gets
        // there second should be told what happened, not silently overrule it.
        if (hotfix.status !== 'REQUESTED') {
          await ctx.answerCallbackQuery({
            text: `${hotfix.key} was already ${hotfix.status.toLowerCase().replace(/_/g, ' ')}`,
            show_alert: true,
          });
          await refreshCard(ctx, auth, 'hotfix', hotfixId);
          return;
        }

        await prisma.hotfix.update({
          where: { id: hotfix.id },
          data: approve ? { status: 'APPROVED', approvedAt: new Date() } : { status: 'REJECTED' },
        });

        const { logActivity } = await import('../services/activity.js');
        const { notify } = await import('../services/notifications.js');

        await logActivity({
          actorId: auth.id,
          action: approve ? 'hotfix.approved' : 'hotfix.rejected',
          entityType: 'HOTFIX',
          entityId: hotfix.id,
          projectId: hotfix.projectId,
          hotfixId: hotfix.id,
          meta: { via: 'telegram' },
        });

        await notify({
          userIds: [hotfix.requestedById, ...(hotfix.assigneeId ? [hotfix.assigneeId] : [])],
          event: 'HOTFIX_STATUS_CHANGED',
          title: `${hotfix.key} ${approve ? 'approved' : 'rejected'}`,
          body: `${auth.user.name} ${approve ? 'approved' : 'rejected'} “${hotfix.title}” from Telegram.`,
          url: `/projects/${hotfix.project.key}/hotfixes/${hotfix.key}`,
          actorId: auth.id,
          projectId: hotfix.projectId,
          hotfixId: hotfix.id,
        });

        await ctx.answerCallbackQuery({
          text: `${hotfix.key} ${approve ? 'approved' : 'rejected'}`,
        });
        await refreshCard(ctx, auth, 'hotfix', hotfixId);
      }),
    );

  hotfixDecision(/^hotfix:approve:(.+)$/, true);
  hotfixDecision(/^hotfix:reject:(.+)$/, false);

  // --- Issue reporting flow ------------------------------------------------

  bot.callbackQuery('report:start', async (ctx) =>
    guard(ctx, async () => {
      const auth = await requireAuth(ctx);

      const projectIds = await auth.projectIdsWith('issue:create');
      const projects = await prisma.project.findMany({
        where: { id: { in: projectIds }, archivedAt: null },
        select: { id: true, key: true, name: true },
        orderBy: { name: 'asc' },
        take: 20,
      });
      if (projects.length === 0) {
        throw new AppError(403, 'FORBIDDEN', 'You cannot report issues on any project');
      }

      const keyboard = new InlineKeyboard();
      projects.forEach((project, index) => {
        keyboard.text(`${project.key} · ${project.name}`, `report:project:${project.id}`);
        if (index < projects.length - 1) keyboard.row();
      });

      await setPending(ctx.chat!.id, { kind: 'report:project' });
      await ctx.answerCallbackQuery();
      await ctx.reply('Which project is this issue in\\?', { ...md, reply_markup: keyboard });
    }),
  );

  bot.callbackQuery(/^report:project:(.+)$/, async (ctx) =>
    guard(ctx, async () => {
      const auth = await requireAuth(ctx);
      const projectId = ctx.match[1]!;
      const access = await auth.requireProject(projectId, 'issue:create');

      await setPending(ctx.chat!.id, { kind: 'report:title', projectId: access.projectId });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        [
          `*${fmt.esc(access.projectKey)}* — describe the problem\\.`,
          '',
          'Send one message\\. The first line becomes the title; anything after it becomes the description\\.',
          '',
          'Send /cancel to stop\\.',
        ].join('\n'),
        md,
      );
    }),
  );

  bot.callbackQuery(/^report:severity:(.+)$/, async (ctx) =>
    guard(ctx, async () => {
      await requireAuth(ctx);

      const pending = await getPending(ctx.chat!.id);
      if (!pending || pending.kind !== 'report:details') {
        throw new AppError(400, 'BAD_REQUEST', 'That report has expired. Start again with /report');
      }

      const severity = ctx.match[1]! as Severity;
      const phases = await prisma.projectPhase.findMany({
        where: { projectId: pending.projectId },
        orderBy: { order: 'asc' },
      });

      await setPending(ctx.chat!.id, { ...pending, severity });

      const keyboard = new InlineKeyboard();
      phases.forEach((phase, index) => {
        keyboard.text(phase.name, `report:phase:${phase.id}`);
        if (index % 2 === 1) keyboard.row();
      });
      keyboard.row().text('Not sure', 'report:phase:none');

      await ctx.answerCallbackQuery();
      await ctx.reply('Where did it happen\\?', { ...md, reply_markup: keyboard });
    }),
  );

  bot.callbackQuery(/^report:phase:(.+)$/, async (ctx) =>
    guard(ctx, async () => {
      const auth = await requireAuth(ctx);

      const pending = await getPending(ctx.chat!.id);
      if (!pending || pending.kind !== 'report:details') {
        throw new AppError(400, 'BAD_REQUEST', 'That report has expired. Start again with /report');
      }

      const raw = ctx.match[1]!;
      const phaseId = raw === 'none' ? null : raw;

      const issue = await mut.createIssueFromTelegram(auth, {
        projectId: pending.projectId,
        title: pending.title,
        description: pending.description ?? null,
        severity: (pending.severity as Severity) ?? 'MAJOR',
        phaseId,
      });

      await setPending(ctx.chat!.id, {
        kind: 'report:attachment',
        issueId: issue.id,
        projectId: pending.projectId,
      });

      await ctx.answerCallbackQuery();
      await ctx.reply(
        [
          `✅ Reported as *${fmt.esc(issue.key)}*\\.`,
          '',
          'Send a screenshot or file now to attach it, or tap Done\\.',
        ].join('\n'),
        {
          ...md,
          reply_markup: fmt.addOpenButton(
            new InlineKeyboard().text('Done', 'report:finish'),
            'Open issue',
            issue.url,
            `issue:menu:${issue.id}`,
          ),
        },
      );
    }),
  );

  bot.callbackQuery('report:finish', async (ctx) =>
    guard(ctx, async () => {
      await clearPending(ctx.chat!.id);
      await ctx.answerCallbackQuery({ text: 'Thanks — the team has been notified.' });
      await ctx.editMessageReplyMarkup().catch(() => undefined);
    }),
  );

  // --- Free-text and media that belong to a pending flow -------------------

  bot.on('message:text', async (ctx, next) => {
    if (ctx.message.text.startsWith('/')) return next();

    const pending = await getPending(ctx.chat.id);

    if (!pending) {
      const auth = await authForChat(ctx.chat.id);
      if (!auth) {
        await ctx.reply(
          'Link your Kiri Task account first with /start, then I can take comments and issue reports from here\\.',
          md,
        );
        return;
      }

      // A key is the most natural thing anybody sends a project bot, so treat
      // it as a request to see that item rather than as a stray message.
      const parsed = parseItemKey(ctx.message.text);
      if (parsed) {
        const found = await findByKey(auth, parsed);
        if (found.found) {
          await sendMenu(ctx, auth, found.kind, found.id);
          return;
        }
        await ctx.reply(
          fmt.esc(`I could not find ${parsed.key}, or it is in a project you cannot open.`),
          md,
        );
        return;
      }

      // Say something. A message typed into a bot that answers with silence
      // reads as "the bot is broken", which is how a draft that expired or
      // outlived a restart used to look.
      await ctx.reply(
        [
          fmt.esc('I was not expecting anything just now — that message has not been saved.'),
          '',
          fmt.esc(
            'Send a key like ACS-12 to pull that item up, /mytasks to see your work, or /report to raise an issue.',
          ),
        ].join('\n'),
        md,
      );
      return;
    }

    const auth = await authForChat(ctx.chat.id);
    if (!auth) {
      await clearPending(ctx.chat.id);
      await ctx.reply('Your account is not linked any more — run /start to link it again\\.', md);
      return;
    }

    try {
      if (pending.kind === 'comment') {
        const result = await mut.addCommentFromTelegram(
          auth,
          pending.entity,
          pending.id,
          ctx.message.text.trim(),
        );
        await clearPending(ctx.chat.id);
        await ctx.reply(`💬 Added to *${fmt.esc(result.label)}*\\.`, {
          ...md,
          reply_markup: fmt.addOpenButton(
            new InlineKeyboard(),
            'Open in Kiri Task',
            result.url,
            `${result.entity}:menu:${result.id}`,
          ),
        });
        return;
      }

      if (pending.kind === 'report:title') {
        const text = ctx.message.text.trim();
        const [firstLine, ...rest] = text.split('\n');
        const title = (firstLine ?? text).slice(0, 280);
        const description = rest.join('\n').trim();

        await setPending(ctx.chat.id, {
          kind: 'report:details',
          projectId: pending.projectId,
          title,
          ...(description ? { description } : {}),
        });

        const keyboard = new InlineKeyboard();
        SEVERITY_CHOICES.forEach((choice, index) => {
          keyboard.text(choice.label, `report:severity:${choice.value}`);
          if (index % 2 === 1) keyboard.row();
        });

        await ctx.reply('How severe is it\\?', { ...md, reply_markup: keyboard });
        return;
      }

      if (pending.kind === 'report:attachment') {
        await ctx.reply('Send an image or file to attach, or tap Done above\\.', md);
        return;
      }

      // The remaining steps are answered with buttons, not typing.
      await ctx.reply('Pick one of the buttons above, or /cancel to stop\\.', md);
      return;
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : 'Something went wrong. Please try the web app.';
      logger.warn({ error, kind: pending.kind }, 'Telegram text flow failed');
      await ctx.reply(`⚠️ ${fmt.esc(message)}`, md);
      return;
    }
  });

  bot.on(['message:photo', 'message:document'], async (ctx) => {
    const pending = await getPending(ctx.chat.id);
    if (!pending || pending.kind !== 'report:attachment') {
      await ctx.reply(
        'Thanks\\! To attach a file to an issue, start with /report or use the Comment button on a notification\\.',
        md,
      );
      return;
    }

    const auth = await authForChat(ctx.chat.id);
    if (!auth) return;

    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new AppError(400, 'BAD_REQUEST', 'Could not read that file');
      const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const filename = ctx.message.document?.file_name ?? `telegram-${file.file_unique_id}.jpg`;

      await mut.attachTelegramFile(auth, {
        issueId: pending.issueId,
        projectId: pending.projectId,
        fileUrl: url,
        filename,
      });

      await ctx.reply('📎 Attached\\. Send another, or tap Done\\.', {
        ...md,
        reply_markup: new InlineKeyboard().text('Done', 'report:finish'),
      });
    } catch (error) {
      const message =
        error instanceof AppError ? error.message : 'That upload failed. Please try the web app.';
      logger.warn({ error }, 'Telegram attachment failed');
      await ctx.reply(`⚠️ ${fmt.esc(message)}`, md);
    }
  });
};
