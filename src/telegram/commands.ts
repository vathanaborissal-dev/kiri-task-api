import { type Bot, InlineKeyboard } from 'grammy';
import { formatDate } from '../lib/dates.js';
import { prisma } from '../lib/prisma.js';
import * as fmt from './format.js';
import { table } from './table.js';
import { authForChat, linkChat } from './service.js';
import { clearPending, setPending } from './state.js';

const OPEN_ISSUE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'READY_FOR_TESTING', 'REOPENED'] as const;

const NOT_LINKED = [
  'Your Telegram account is not connected to Kiri Task yet\\.',
  '',
  `Open *Settings → Telegram* in the web app, generate a connection code, then send it here as \`/start CODE\`\\.`,
].join('\n');

export const registerCommands = (bot: Bot) => {
  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim();

    if (code) {
      const result = await linkChat(code, ctx.chat.id, ctx.from?.username);
      if (result.ok) {
        await ctx.reply(
          `✅ Connected\\. Welcome, *${fmt.esc(result.name)}*\\.\n\n${fmt.HELP_TEXT}`,
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
      `You are signed in as *${fmt.esc(auth.user.name)}*\\.\n\n${fmt.HELP_TEXT}`,
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(fmt.HELP_TEXT, { parse_mode: 'MarkdownV2' });
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
        : 'The web app link will appear here after Kiri Task is deployed\.',
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
    const tasks = await prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        assignees: { some: { userId: auth.id } },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
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
        fmt.sectionHeader('Your open tasks', tasks.length),
        '',
        ...tasks.map((t) => fmt.taskLine(t, auth.user.timezone)),
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: keyboard },
    );
  });

  bot.command('today', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const [due, inProgress] = await Promise.all([
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
    const issues = await prisma.issue.findMany({
      where: {
        projectId: { in: projectIds },
        OR: [{ assigneeId: auth.id }, { reporterId: auth.id }],
        status: { in: [...OPEN_ISSUE_STATUSES] },
      },
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
        fmt.sectionHeader('Your issues', issues.length),
        '',
        ...issues.map((i) => fmt.issueLine(i, auth.user.timezone)),
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

  // --- Everything, not just mine -------------------------------------------
  // `/mytasks` and `/issues` answer "what is on me". These answer "what is on
  // the team", scoped to the projects the caller may read, so the bot never
  // reveals a project they cannot open in the app.

  bot.command('alltasks', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('task:view');
    const tasks = await prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
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
        fmt.sectionHeader('All open tasks', tasks.length),
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
            t.status.name,
            t.assignees.map((a) => a.user.name.split(' ')[0]).join(', ') || '—',
            t.dueDate ? formatDate(t.dueDate, auth.user.timezone) : '—',
          ]),
        ),
      ].join('\n'),
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('allissues', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('issue:view');
    const issues = await prisma.issue.findMany({
      where: { projectId: { in: projectIds }, status: { in: [...OPEN_ISSUE_STATUSES] } },
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
        fmt.sectionHeader('All open issues', issues.length),
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
            i.severity,
            i.status.replace(/_/g, ' '),
            i.assignee?.name.split(' ')[0] ?? 'unassigned',
          ]),
        ),
      ].join('\n'),
      { parse_mode: 'MarkdownV2' },
    );
  });

  bot.command('hotfixes', async (ctx) => {
    const auth = await authForChat(ctx.chat.id);
    if (!auth) return void ctx.reply(NOT_LINKED, { parse_mode: 'MarkdownV2' });

    const projectIds = await auth.projectIdsWith('hotfix:view');
    const hotfixes = await prisma.hotfix.findMany({
      where: { projectId: { in: projectIds }, status: { in: [...OPEN_HOTFIX_STATUSES] } },
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

    if (hotfixes.length === 0) return void emptyNotice(ctx, 'hotfixes in flight');

    await ctx.reply(
      [
        fmt.sectionHeader('Hotfixes in flight', hotfixes.length),
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
            h.severity,
            h.status.replace(/_/g, ' '),
            h.assignee?.name.split(' ')[0] ?? 'unassigned',
          ]),
        ),
      ].join('\n'),
      { parse_mode: 'MarkdownV2' },
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
    await clearPending(ctx.chat.id);
    await ctx.reply('Cancelled\\.', { parse_mode: 'MarkdownV2' });
  });

  // Unknown command — point people at /help rather than staying silent.
  bot.on('message:text', async (ctx, next) => {
    if (!ctx.message.text.startsWith('/')) return next();
    const known = [
      '/start',
      '/help',
      '/me',
      '/mytasks',
      '/today',
      '/overdue',
      '/issues',
      '/projects',
      '/report',
      '/cancel',
    ];
    const command = ctx.message.text.split(/[\s@]/)[0];
    if (command && known.includes(command)) return next();
    await ctx.reply(`Unknown command\\. Try /help\\.`, { parse_mode: 'MarkdownV2' });
  });
};
