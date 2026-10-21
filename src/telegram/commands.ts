import { type Bot, InlineKeyboard } from 'grammy';
import type { Prisma } from '../generated/prisma/client.js';
import { endOfToday, formatDate, startOfToday } from '../lib/dates.js';
import { prisma } from '../lib/prisma.js';
import * as fmt from './format.js';
import { table } from './table.js';
import { KNOWN_COMMANDS } from './catalog.js';
import { authForChat, linkChat } from './service.js';
import { clearPending, getPending, setPending } from './state.js';

const OPEN_ISSUE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'READY_FOR_TESTING', 'REOPENED'] as const;

const NOT_LINKED = [
  'Your Telegram account is not connected to Kiri Task yet\\.',
  '',
  `Open *Settings → Telegram* in the web app, generate a connection code, then send it here as \`/start CODE\`\\.`,
].join('\n');

export const registerCommands = (bot: Bot) => {
  /**
   * The bot acts as whoever linked the chat, so in a group every member would
   * be acting as that one person — filing their issues, closing their tasks.
   * Rather than offer a connection code that would do exactly that, say where
   * it does work. Ordinary group chatter is left alone.
   */
  bot.on('message', async (ctx, next) => {
    if (ctx.chat.type === 'private') return next();
    if (!ctx.message.text?.startsWith('/')) return;
    await ctx.reply(
      fmt.esc(
        'I work in a direct message, not in a group — everything I do happens as the person I am connected to. Message me directly and send /start.',
      ),
      { parse_mode: 'MarkdownV2' },
    );
  });

  /** A blank line and a note, when a list showed less than it found. */
  const noteLines = (shown: number, total: number): string[] => {
    const note = fmt.truncationNote(shown, total);
    return note ? ['', note] : [];
  };

  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim();

    if (code) {
      const result = await linkChat(code, ctx.chat.id, ctx.from?.username);
      if (result.ok) {
        await ctx.reply(
          `✅ Connected\\. Welcome, *${fmt.esc(result.name)}*\\.\n\n${fmt.helpText()}`,
          { parse_mode: 'MarkdownV2' },
        );
        return;
      }
      await ctx.reply(`⚠️ ${fmt.esc(result.reason)}`, { parse_mode: 'MarkdownV2' });
      return;
    }

    const auth = await authForChat(ctx.chat.id);
    if (!auth) {
      await ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });
      return;
    }
    await ctx.reply(
      `You are signed in as *${fmt.esc(auth.user.name)}*\\.\n\n${fmt.helpText()}`,
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(fmt.helpText(), { parse_mode: 'MarkdownV2' });
  });

  /** Opens the web app — as a Mini App inside Telegram where that is possible. */
  bot.command('app', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const keyboard = new InlineKeyboard();
    for (const [label, path] of [
      ['📊 Dashboard', '/dashboard'],
      ['🌅 Today', '/today'],
      ['✅ My work', '/my-work'],
      ['🐞 Issues', '/issues'],
    ] as const) {
      const button = fmt.openButton(label, path);
      if (button?.webApp) keyboard.webApp(label, button.webApp).row();
      else if (button?.url) keyboard.url(label, button.url).row();
    }

    await ctx.reply(
      fmt.miniAppUrl()
        ? 'Open Kiri Task without leaving Telegram:'
        : fmt.esc('The web app link will appear here once Kiri Task is deployed.'),
      {
        parse_mode: 'MarkdownV2',
        ...(fmt.openButton('Open', '/dashboard') ? { reply_markup: keyboard } : {}),
      },
    );
  });

  bot.command('me', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.accessibleProjectIds();
    const [openTasks, openIssues, unread] = await Promise.all([
      prisma.task.count({
        where: {
          projectId: { in: projectIds },
          assignees: { some: { userId: auth.id } },
          status: { category: { notIn: ['DONE', 'CANCELED'] } },
        },
      }),
      prisma.issue.count({
        where: {
          projectId: { in: projectIds },
          assigneeId: auth.id,
          status: { in: [...OPEN_ISSUE_STATUSES] },
        },
      }),
      prisma.notification.count({ where: { userId: auth.id, readAt: null } }),
    ]);

    const lines = [
      `*${fmt.esc(auth.user.name)}*`,
      fmt.esc(auth.user.email),
      `Role: ${fmt.esc(auth.user.globalRole.name)}`,
      '',
      `Open tasks: *${openTasks}*`,
      `Open issues: *${openIssues}*`,
      `Unread notifications: *${unread}*`,
      `Projects: *${projectIds.length}*`,
    ];

    const keyboard = new InlineKeyboard();
    fmt.addOpenButton(keyboard, 'Open Kiri Task', '/dashboard');
    if (fmt.openButton('Settings', '/settings/notifications')) {
      keyboard.row();
      fmt.addOpenButton(keyboard, 'Notification settings', '/settings/notifications');
    }
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      ...(fmt.openButton('Open', '/dashboard') ? { reply_markup: keyboard } : {}),
    });
  });

  bot.command('mytasks', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');
    const mine: Prisma.TaskWhereInput = {
      projectId: { in: projectIds },
      assignees: { some: { userId: auth.id } },
      status: { category: { notIn: ['DONE', 'CANCELED'] } },
    };
    const total = await prisma.task.count({ where: mine });
    const tasks = await prisma.task.findMany({
      where: mine,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
      take: 15,
      select: {
        id: true,
        key: true,
        title: true,
        priority: true,
        dueDate: true,
        status: { select: { name: true, category: true } },
        phase: { select: { name: true } },
        project: { select: { key: true } },
      },
    });

    if (tasks.length === 0) {
      await ctx.reply('🎉 Nothing assigned to you right now\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    const keyboard = new InlineKeyboard();
    tasks.slice(0, 6).forEach((task, index) => {
      keyboard.text(task.key, `task:menu:${task.id}`);
      if (index % 3 === 2) keyboard.row();
    });
    if (fmt.openButton('Open My Work', '/my-work')) {
      keyboard.row();
      fmt.addOpenButton(keyboard, 'Open My Work', '/my-work');
    }

    await ctx.reply(
      [
        fmt.sectionHeader('Your open tasks', total),
        '',
        ...tasks.map((t) => fmt.taskLine(t, auth.user.timezone)),
        ...noteLines(tasks.length, total),
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: keyboard },
    );
  });

  bot.command('today', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');

    // In this person's day, not the server's. `setHours` reads whatever zone
    // the process happens to run in — Asia/Phnom_Penh on a laptop, UTC on
    // Vercel — which moved the boundary seven hours and quietly put evening
    // work on the wrong day.
    const start = startOfToday(auth.user.timezone);
    const end = endOfToday(auth.user.timezone);

    const [due, inProgress, overdue] = await Promise.all([
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignees: { some: { userId: auth.id } },
          dueDate: { gte: start, lte: end },
          status: { category: { notIn: ['DONE', 'CANCELED'] } },
        },
        orderBy: { priority: 'desc' },
        select: {
          key: true,
          title: true,
          priority: true,
          dueDate: true,
          status: { select: { name: true, category: true } },
          phase: { select: { name: true } },
          project: { select: { key: true } },
        },
      }),
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignees: { some: { userId: auth.id } },
          status: { category: 'IN_PROGRESS' },
        },
        take: 10,
        select: {
          key: true,
          title: true,
          priority: true,
          dueDate: true,
          status: { select: { name: true, category: true } },
          phase: { select: { name: true } },
          project: { select: { key: true } },
        },
      }),
      prisma.task.count({
        where: {
          projectId: { in: projectIds },
          assignees: { some: { userId: auth.id } },
          dueDate: { lt: start },
          status: { category: { notIn: ['DONE', 'CANCELED'] } },
        },
      }),
    ]);

    const parts: string[] = [fmt.sectionHeader('Today')];
    if (due.length) {
      parts.push('', fmt.sectionHeader('Due today', due.length), ...due.map((t) => fmt.taskLine(t, auth.user.timezone)));
    }
    if (inProgress.length) {
      parts.push('', fmt.sectionHeader('In progress', inProgress.length), ...inProgress.map((t) => fmt.taskLine(t, auth.user.timezone)));
    }
    if (due.length === 0 && inProgress.length === 0) {
      parts.push('', 'Nothing due today and nothing in progress\\.');
    }
    // Yesterday's work does not stop mattering at midnight. Without this a
    // clear day reads as "nothing to do" while five things sit overdue.
    if (overdue > 0) {
      parts.push(
        '',
        fmt.esc(`⚠️ ${overdue} already overdue — see /overdue.`),
      );
    }

    const keyboard = new InlineKeyboard();
    fmt.addOpenButton(keyboard, 'Open My Work', '/my-work');
    await ctx.reply(parts.join('\n'), {
      parse_mode: 'MarkdownV2',
      ...(fmt.openButton('Open My Work', '/my-work') ? { reply_markup: keyboard } : {}),
    });
  });

  bot.command('overdue', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');
    const now = new Date();

    const [tasks, issues] = await Promise.all([
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          assignees: { some: { userId: auth.id } },
          dueDate: { lt: now },
          status: { category: { notIn: ['DONE', 'CANCELED'] } },
        },
        orderBy: { dueDate: 'asc' },
        take: 15,
        select: {
          key: true,
          title: true,
          priority: true,
          dueDate: true,
          status: { select: { name: true, category: true } },
          phase: { select: { name: true } },
          project: { select: { key: true } },
        },
      }),
      prisma.issue.findMany({
        where: {
          projectId: { in: projectIds },
          assigneeId: auth.id,
          dueDate: { lt: now },
          status: { in: [...OPEN_ISSUE_STATUSES] },
        },
        orderBy: { dueDate: 'asc' },
        take: 10,
        select: {
          key: true,
          title: true,
          severity: true,
          status: true,
          dueDate: true,
          phase: { select: { name: true } },
          project: { select: { key: true } },
        },
      }),
    ]);

    if (tasks.length === 0 && issues.length === 0) {
      await ctx.reply('✅ Nothing of yours is overdue\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    const parts: string[] = [];
    if (tasks.length) {
      parts.push(fmt.sectionHeader('Overdue tasks', tasks.length), ...tasks.map((t) => fmt.taskLine(t, auth.user.timezone)));
    }
    if (issues.length) {
      if (parts.length) parts.push('');
      parts.push(fmt.sectionHeader('Overdue issues', issues.length), ...issues.map((i) => fmt.issueLine(i, auth.user.timezone)));
    }

    await ctx.reply(parts.join('\n'), { parse_mode: 'MarkdownV2' });
  });

  bot.command('issues', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('issue:view');
    const mine: Prisma.IssueWhereInput = {
      projectId: { in: projectIds },
      OR: [{ assigneeId: auth.id }, { reporterId: auth.id }],
      status: { in: [...OPEN_ISSUE_STATUSES] },
    };
    const total = await prisma.issue.count({ where: mine });
    const issues = await prisma.issue.findMany({
      where: mine,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 15,
      select: {
        id: true,
        key: true,
        title: true,
        severity: true,
        status: true,
        dueDate: true,
        phase: { select: { name: true } },
        project: { select: { key: true } },
      },
    });

    if (issues.length === 0) {
      await ctx.reply('No open issues assigned to or reported by you\\.', {
        parse_mode: 'MarkdownV2',
        reply_markup: new InlineKeyboard().text('🐞 Report an issue', 'report:start'),
      });
      return;
    }

    const keyboard = new InlineKeyboard();
    issues.slice(0, 6).forEach((issue, index) => {
      keyboard.text(issue.key, `issue:menu:${issue.id}`);
      if (index % 3 === 2) keyboard.row();
    });
    keyboard.row().text('🐞 Report an issue', 'report:start');

    await ctx.reply(
      [
        fmt.sectionHeader('Your issues', total),
        '',
        ...issues.map((i) => fmt.issueLine(i, auth.user.timezone)),
        ...noteLines(issues.length, total),
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: keyboard },
    );
  });

  const OPEN_HOTFIX_STATUSES = [
    'REQUESTED',
    'APPROVED',
    'IN_PROGRESS',
    'IN_TESTING',
    'READY',
  ] as const;

  /** How many rows a phone can scan before the block becomes a scroll. */
  const LIST_LIMIT = 25;

  type Replier = {
    reply: (text: string, other?: { parse_mode?: 'MarkdownV2' }) => Promise<unknown>;
  };

  const emptyNotice = async (ctx: Replier, what: string) => {
    await ctx.reply(fmt.esc(`Nothing open: no ${what} you can see right now.`), {
      parse_mode: 'MarkdownV2',
    });
  };

  /**
   * Closes a table with what it left out and how to open a row.
   *
   * The tables are not tappable — twenty-five buttons would bury the list —
   * so the way into a row is its key, which the bot now understands on its own.
   */
  const listFooter = (shown: number, total: number): string[] => {
    const note = fmt.truncationNote(shown, total);
    return ['', ...(note ? [note] : []), fmt.esc('Send a key to open one.')];
  };

  // --- Everything, not just mine -------------------------------------------
  // `/mytasks` and `/issues` answer "what is on me". These answer "what is on
  // the team", scoped to the projects the caller may read, so the bot never
  // reveals a project they cannot open in the app.

  bot.command('alltasks', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');
    const where: Prisma.TaskWhereInput = {
      projectId: { in: projectIds },
      status: { category: { notIn: ['DONE', 'CANCELED'] } },
    };
    const total = await prisma.task.count({ where });
    const tasks = await prisma.task.findMany({
      where,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
      take: LIST_LIMIT,
      select: {
        key: true,
        title: true,
        dueDate: true,
        status: { select: { name: true } },
        assignees: { select: { user: { select: { name: true } } }, take: 2 },
      },
    });

    if (tasks.length === 0) return void emptyNotice(ctx, 'open tasks');

    await ctx.reply(
      [
        fmt.sectionHeader('All open tasks', total),
        '',
        table(
          [
            { header: 'key', width: 10 },
            { header: 'task', width: 30 },
            { header: 'status', width: 12 },
            { header: 'who', width: 12 },
            { header: 'due', width: 6 },
          ],
          tasks.map((t) => [
            t.key,
            t.title,
            t.status.name.toLowerCase(),
            t.assignees.map((a) => a.user.name.split(' ')[0]).join(', ') || '—',
            t.dueDate ? formatDate(t.dueDate, auth.user.timezone) : '—',
          ]),
        ),
        ...listFooter(tasks.length, total),
      ].join('\n'),
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('allissues', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('issue:view');
    const where: Prisma.IssueWhereInput = {
      projectId: { in: projectIds },
      status: { in: [...OPEN_ISSUE_STATUSES] },
    };
    const total = await prisma.issue.count({ where });
    const issues = await prisma.issue.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: LIST_LIMIT,
      select: {
        key: true,
        title: true,
        severity: true,
        status: true,
        assignee: { select: { name: true } },
      },
    });

    if (issues.length === 0) return void emptyNotice(ctx, 'open issues');

    await ctx.reply(
      [
        fmt.sectionHeader('All open issues', total),
        '',
        table(
          [
            { header: 'key', width: 10 },
            { header: 'issue', width: 28 },
            { header: 'severity', width: 8 },
            { header: 'status', width: 12 },
            { header: 'who', width: 12 },
          ],
          issues.map((i) => [
            i.key,
            i.title,
            i.severity.toLowerCase(),
            fmt.humanStatus(i.status),
            i.assignee?.name.split(' ')[0] ?? 'unassigned',
          ]),
        ),
        ...listFooter(issues.length, total),
      ].join('\n'),
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('hotfixes', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('hotfix:view');
    const where: Prisma.HotfixWhereInput = {
      projectId: { in: projectIds },
      status: { in: [...OPEN_HOTFIX_STATUSES] },
    };
    const total = await prisma.hotfix.count({ where });
    const hotfixes = await prisma.hotfix.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: LIST_LIMIT,
      select: {
        id: true,
        key: true,
        title: true,
        severity: true,
        status: true,
        assignee: { select: { name: true } },
      },
    });

    if (hotfixes.length === 0) return void emptyNotice(ctx, 'hotfixes in flight');

    // A hotfix waiting on approval is the one thing here that is urgent, so the
    // first few are one tap from the card that can approve them.
    const keyboard = new InlineKeyboard();
    hotfixes.slice(0, 6).forEach((hotfix, index) => {
      keyboard.text(hotfix.key, `hotfix:menu:${hotfix.id}`);
      if (index % 3 === 2) keyboard.row();
    });

    await ctx.reply(
      [
        fmt.sectionHeader('Hotfixes in flight', total),
        '',
        table(
          [
            { header: 'key', width: 10 },
            { header: 'hotfix', width: 30 },
            { header: 'severity', width: 8 },
            { header: 'status', width: 11 },
            { header: 'who', width: 12 },
          ],
          hotfixes.map((h) => [
            h.key,
            h.title,
            h.severity.toLowerCase(),
            fmt.humanStatus(h.status),
            h.assignee?.name.split(' ')[0] ?? 'unassigned',
          ]),
        ),
        ...listFooter(hotfixes.length, total),
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: keyboard },
    );
  });

  bot.command('projects', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const memberships = await prisma.projectMember.findMany({
      where: { userId: auth.id },
      select: {
        responsibilities: true,
        role: { select: { name: true } },
        project: {
          select: {
            key: true,
            name: true,
            status: true,
            targetDate: true,
            _count: { select: { tasks: true, issues: true } },
          },
        },
      },
      orderBy: { project: { name: 'asc' } },
    });

    if (memberships.length === 0) {
      await ctx.reply('You are not a member of any project yet\\.', { parse_mode: 'MarkdownV2' });
      return;
    }

    const lines = memberships.map((m) =>
      [
        `*${fmt.esc(m.project.key)}* ${fmt.esc(m.project.name)}`,
        `   ${fmt.esc(m.role.name)} · ${fmt.esc(m.project.status.toLowerCase())} · ${m.project._count.tasks} tasks · ${m.project._count.issues} issues`,
      ].join('\n'),
    );

    const keyboard = new InlineKeyboard();
    memberships.slice(0, 6).forEach((m, index) => {
      const button = fmt.openButton(m.project.key, `/projects/${m.project.key}`);
      if (button?.webApp) keyboard.webApp(m.project.key, button.webApp);
      else if (button?.url) keyboard.url(m.project.key, button.url);
      if (button && index % 3 === 2) keyboard.row();
    });

    await ctx.reply([fmt.sectionHeader('Your projects', memberships.length), '', ...lines].join('\n'), {
      parse_mode: 'MarkdownV2',
      ...(fmt.openButton('Open', `/projects/${memberships[0]!.project.key}`)
        ? { reply_markup: keyboard }
        : {}),
    });
  });

  bot.command('report', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('issue:create');
    if (projectIds.length === 0) {
      await ctx.reply('You do not have permission to report issues on any project\\.', {
        parse_mode: 'MarkdownV2',
      });
      return;
    }

    const projects = await prisma.project.findMany({
      where: { id: { in: projectIds }, archivedAt: null },
      select: { id: true, key: true, name: true },
      orderBy: { name: 'asc' },
      take: 20,
    });

    const keyboard = new InlineKeyboard();
    projects.forEach((project, index) => {
      keyboard.text(`${project.key} · ${project.name}`, `report:project:${project.id}`);
      if (index < projects.length - 1) keyboard.row();
    });

    await setPending(ctx.chat.id, { kind: 'report:project' });
    await ctx.reply('Which project is this issue in\\?', {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  });

  bot.command('cancel', async (ctx) => {
    // Saying "Cancelled." when nothing was in progress leaves people wondering
    // what they just cancelled.
    const pending = await getPending(ctx.chat.id);
    await clearPending(ctx.chat.id);
    await ctx.reply(
      pending ? 'Cancelled\\.' : fmt.esc('Nothing was in progress — nothing to cancel.'),
      { parse_mode: 'MarkdownV2' },
    );
  });

  // Unknown command — point people at /help rather than staying silent.
  bot.on('message:text', async (ctx, next) => {
    if (!ctx.message.text.startsWith('/')) return next();
    const command = ctx.message.text.split(/[\s@]/)[0];
    if (command && KNOWN_COMMANDS.has(command)) return next();
    await ctx.reply(fmt.esc(`Unknown command ${command}. Try /help.`), {
      parse_mode: 'MarkdownV2',
    });
  });
};
