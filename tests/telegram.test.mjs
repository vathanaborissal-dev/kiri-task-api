import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createBot } from '../src/telegram/bot.ts';
import { ALL_COMMANDS } from '../src/telegram/catalog.ts';
import { prisma } from '../src/lib/prisma.ts';
import { signIn, unique } from './helpers.mjs';

/**
 * Drives the real bot without touching Telegram.
 *
 * Every outbound API call is intercepted by a transformer, and updates are fed
 * straight into `bot.handleUpdate`, so the command handlers, permission checks,
 * database writes, activity log and notifications all run for real — only the
 * transport is faked.
 *
 *   npm run test:telegram
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

/** A chat id well outside Telegram's real range, so nothing can collide. */
const CHAT_ID = 9_000_000_001;
const TELEGRAM_USER = { id: CHAT_ID, is_bot: false, first_name: 'Suite', username: 'suite_tester' };
const CHAT = { id: CHAT_ID, type: 'private', first_name: 'Suite' };

let bot;
let sent = [];
let updateId = 1;
let admin;
let adminUser;
let project;
let task;
let issue;
let hotfix;
let originalAdminTelegram;

/** Minimal plausible results for the handful of methods the bot calls. */
const fakeResult = (method, payload) => {
  switch (method) {
    case 'getMe':
      return { id: 1, is_bot: true, first_name: 'KiriTask', username: 'kiri_task_bot' };
    case 'sendMessage':
      return { message_id: Math.floor(Math.random() * 1e6), chat: CHAT, date: 0, text: payload.text };
    case 'getFile':
      return { file_id: payload.file_id, file_unique_id: 'u1', file_path: 'photos/test.jpg' };
    default:
      return true;
  }
};

const textUpdate = (text) => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    date: Math.floor(Date.now() / 1000),
    chat: CHAT,
    from: TELEGRAM_USER,
    text,
    ...(text.startsWith('/')
      ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] }
      : {}),
  },
});

const callbackUpdate = (data) => ({
  update_id: updateId++,
  callback_query: {
    id: String(updateId),
    from: TELEGRAM_USER,
    chat_instance: '1',
    data,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: CHAT,
      from: { id: 1, is_bot: true, first_name: 'KiriTask' },
      text: 'placeholder',
    },
  },
});


/**
 * Telegram refuses a whole message when one reserved character is not escaped,
 * so a formatting slip does not come out plain — it does not come out at all.
 * Four replies shipped that way because the fake transport here accepted
 * anything. Every message the suite provokes is now checked.
 *
 * Only the characters that MarkdownV2 never uses for formatting are checked,
 * which is where the mistake is always made: `*`, `_`, `[`, `]`, `(` and `)`
 * are left alone because they carry bold, italics and links.
 */
const MUST_BE_ESCAPED = /[.!+=|{}>#~-]/;

const stripCode = (text) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');

const unescapedAt = (text) => {
  const body = stripCode(text);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (!MUST_BE_ESCAPED.test(char)) continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && body[back] === '\\'; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return { char, index, near: body.slice(Math.max(0, index - 40), index + 10) };
  }
  return null;
};

const assertParsable = (calls) => {
  for (const call of calls) {
    if (call.method !== 'sendMessage' && call.method !== 'editMessageText') continue;
    if (call.payload.parse_mode !== 'MarkdownV2') continue;
    const bad = unescapedAt(call.payload.text ?? '');
    assert.equal(
      bad,
      null,
      bad
        ? `Telegram would reject this message: unescaped "${bad.char}" after …${bad.near}`
        : '',
    );
  }
};

/** Feeds an update and returns everything the bot tried to send because of it. */
const feed = async (update) => {
  sent = [];
  await bot.handleUpdate(update);
  assertParsable(sent);
  return sent;
};

const texts = (calls) =>
  calls.filter((call) => call.method === 'sendMessage').map((call) => call.payload.text);

const alerts = (calls) =>
  calls.filter((call) => call.method === 'answerCallbackQuery').map((call) => call.payload.text ?? '');

const allText = (calls) => [...texts(calls), ...alerts(calls)].join('\n');

before(async () => {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');

  bot = createBot();
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: fakeResult(method, payload) };
  });
  await bot.init();

  const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  admin = session.client;
  adminUser = session.user;

  originalAdminTelegram = await prisma.user.findUniqueOrThrow({
    where: { id: adminUser.id },
    select: {
      telegramChatId: true,
      telegramUsername: true,
      telegramLinkedAt: true,
    },
  });

  // Keep this suite isolated from a real Telegram account. The linking tests
  // use a fake chat id, then the original connection is restored in `after`.
  await prisma.user.update({
    where: { id: adminUser.id },
    data: { telegramChatId: null, telegramUsername: null, telegramLinkedAt: null },
  });

  const key = `B${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const created = await admin.post('/projects', { name: `Bot test ${key}`, key });
  project = (await admin.get(`/projects/${created.json.data.key}`)).json.data;

  task = (
    await admin.post('/tasks', {
      projectId: project.id,
      title: 'Bot can move me',
      assigneeIds: [adminUser.id],
      priority: 'HIGH',
    })
  ).json.data;

  issue = (
    await admin.post('/issues', {
      projectId: project.id,
      title: 'Bot can resolve me',
      severity: 'MAJOR',
      assigneeId: adminUser.id,
    })
  ).json.data;

  hotfix = (
    await admin.post('/hotfixes', {
      projectId: project.id,
      title: 'Bot can approve me',
      createTask: false,
    })
  ).json.data;
});

after(async () => {
  // Leave no trace: restore the real account connection exactly as it was.
  if (adminUser && originalAdminTelegram) {
    await prisma.user.update({
      where: { id: adminUser.id },
      data: originalAdminTelegram,
    });
  }
  if (project) await admin.delete(`/projects/${project.key}`, { confirm: project.key });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('account linking', () => {
  it('tells an unknown chat how to connect', async () => {
    const reply = allText(await feed(textUpdate('/mytasks')));
    assert.match(reply, /not connected/i);
    assert.match(reply, /Settings/);
  });

  it('refuses a code that was never issued', async () => {
    const reply = allText(await feed(textUpdate('/start ZZZZZZZZ')));
    assert.match(reply, /not valid/i);

    const stillUnlinked = await prisma.user.findFirst({
      where: { telegramChatId: BigInt(CHAT_ID) },
    });
    assert.equal(stillUnlinked, null);
  });

  it('links the account when the code from the web app is sent', async () => {
    const { code } = (await admin.post('/telegram/link-code')).json.data;
    const reply = allText(await feed(textUpdate(`/start ${code}`)));

    assert.match(reply, /Connected/i);

    const linked = await prisma.user.findFirst({ where: { telegramChatId: BigInt(CHAT_ID) } });
    assert.ok(linked, 'the chat should now map to a user');
    assert.equal(linked.id, adminUser.id);
    assert.equal(linked.telegramUsername, 'suite_tester');
  });

  it('will not let the same code be used twice', async () => {
    const { code } = (await admin.post('/telegram/link-code')).json.data;
    await feed(textUpdate(`/start ${code}`));
    const second = allText(await feed(textUpdate(`/start ${code}`)));
    assert.match(second, /not valid/i);
  });

  it('records the link in the activity log', async () => {
    const entry = await prisma.activityLog.findFirst({
      where: { actorId: adminUser.id, action: 'telegram.linked' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entry, 'linking should be auditable');
  });
});

// ---------------------------------------------------------------------------

describe('read-only commands', () => {
  it('/help lists every command', async () => {
    const reply = allText(await feed(textUpdate('/help')));
    for (const command of ['/mytasks', '/today', '/overdue', '/issues', '/projects', '/report']) {
      assert.ok(reply.includes(command), `${command} should be documented`);
    }
  });

  it('/me shows who you are and your workload', async () => {
    const reply = allText(await feed(textUpdate('/me')));
    assert.ok(reply.includes(adminUser.name.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1')));
    assert.match(reply, /Open tasks/);
    assert.match(reply, /Projects/);
  });

  it('/mytasks lists work assigned to you', async () => {
    const calls = await feed(textUpdate('/mytasks'));
    const reply = allText(calls);
    assert.ok(reply.includes(task.key.replace(/-/g, '\\-')), 'the assigned task should be listed');

    const keyboard = calls.find((call) => call.method === 'sendMessage')?.payload.reply_markup;
    assert.ok(keyboard, 'tasks should come with action buttons');
  });

  it('/projects lists the projects you belong to', async () => {
    const reply = allText(await feed(textUpdate('/projects')));
    assert.ok(reply.includes(project.key));
  });

  it('/issues lists issues assigned to or reported by you', async () => {
    const reply = allText(await feed(textUpdate('/issues')));
    assert.ok(reply.includes(issue.key.replace(/-/g, '\\-')));
  });

  it('/today and /overdue answer without errors', async () => {
    assert.ok(allText(await feed(textUpdate('/today'))).length > 0);
    assert.ok(allText(await feed(textUpdate('/overdue'))).length > 0);
  });

  it('points an unknown command at /help', async () => {
    const reply = allText(await feed(textUpdate('/sudo')));
    assert.match(reply, /Unknown command/i);
  });
});

// ---------------------------------------------------------------------------

describe('acting on work from Telegram', () => {
  it('moves a task to In Progress from a notification button', async () => {
    const calls = await feed(callbackUpdate(`task:start:${task.id}`));
    assert.match(alerts(calls).join(' '), new RegExp(task.key));

    const moved = await prisma.task.findUnique({
      where: { id: task.id },
      include: { status: true },
    });
    assert.equal(moved.status.category, 'IN_PROGRESS');
  });

  it('marks a task done and stamps completedAt', async () => {
    await feed(callbackUpdate(`task:done:${task.id}`));

    const done = await prisma.task.findUnique({
      where: { id: task.id },
      include: { status: true },
    });
    assert.equal(done.status.category, 'DONE');
    assert.ok(done.completedAt, 'finishing from Telegram should stamp completedAt');
  });

  it('says so when the task is already in that state', async () => {
    const calls = await feed(callbackUpdate(`task:done:${task.id}`));
    assert.match(alerts(calls).join(' '), /already/i);
  });

  it('writes the same activity trail as the website', async () => {
    const entries = await prisma.activityLog.findMany({
      where: { taskId: task.id, action: 'task.status_changed' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entries.length >= 2);
    assert.equal(entries[0].meta.via, 'telegram', 'the trail should record where it came from');
  });

  it('shows a task menu with its real details', async () => {
    const reply = allText(await feed(callbackUpdate(`task:menu:${task.id}`)));
    assert.ok(reply.includes(task.key.replace(/-/g, '\\-')));
    assert.match(reply, /Status:/);
    assert.match(reply, /Testing:/);
  });

  it('accepts a comment typed into the chat', async () => {
    await feed(callbackUpdate(`task:comment:${task.id}`));
    const reply = allText(await feed(textUpdate('Picked this up from my phone.')));
    assert.match(reply, /Added to/i);

    const comment = await prisma.comment.findFirst({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(comment.body, 'Picked this up from my phone.');
    assert.equal(comment.authorId, adminUser.id);
  });

  it('only treats the next message as a comment, not every message after', async () => {
    const before = await prisma.comment.count({ where: { taskId: task.id } });
    await feed(textUpdate('just chatting'));
    const after = await prisma.comment.count({ where: { taskId: task.id } });
    assert.equal(after, before, 'the pending state should be cleared once used');
  });

  it('moves an issue through its workflow', async () => {
    await feed(callbackUpdate(`issue:start:${issue.id}`));
    assert.equal((await prisma.issue.findUnique({ where: { id: issue.id } })).status, 'IN_PROGRESS');

    await feed(callbackUpdate(`issue:testing:${issue.id}`));
    assert.equal(
      (await prisma.issue.findUnique({ where: { id: issue.id } })).status,
      'READY_FOR_TESTING',
    );

    await feed(callbackUpdate(`issue:resolve:${issue.id}`));
    const resolved = await prisma.issue.findUnique({ where: { id: issue.id } });
    assert.equal(resolved.status, 'RESOLVED');
    assert.ok(resolved.resolvedAt);
  });

  it('approves a hotfix from the chat', async () => {
    const calls = await feed(callbackUpdate(`hotfix:approve:${hotfix.id}`));
    assert.match(alerts(calls).join(' '), /approved/i);

    const approved = await prisma.hotfix.findUnique({ where: { id: hotfix.id } });
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.approvedAt);
  });

  it('refuses to act on something that does not exist', async () => {
    const calls = await feed(callbackUpdate('task:start:not-a-real-id'));
    assert.match(alerts(calls).join(' '), /not found/i);
  });
});

// ---------------------------------------------------------------------------

describe('half-finished conversations', () => {
  it('keeps a pending comment where a restart cannot lose it', async () => {
    await feed(callbackUpdate(`task:comment:${task.id}`));

    const stored = await prisma.telegramPending.findUnique({
      where: { chatId: BigInt(CHAT_ID) },
    });
    assert.ok(stored, 'the draft is in the database, not in the process');
    assert.equal(stored.action.kind, 'comment');
    assert.equal(stored.action.id, task.id);

    // The key comes back MarkdownV2-escaped, so match the confirmation itself.
    const calls = await feed(textUpdate('Picked this up after a redeploy'));
    assert.match(allText(calls), /Added to/);

    const comment = await prisma.comment.findFirst({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
    });
    assert.equal(comment.body, 'Picked this up after a redeploy');
  });

  it('answers a stray message instead of swallowing it', async () => {
    await prisma.telegramPending.deleteMany({ where: { chatId: BigInt(CHAT_ID) } });

    const calls = await feed(textUpdate('hello?'));
    assert.match(allText(calls), /not expecting anything/i);
  });

  it('drops a draft that has expired, and says so', async () => {
    await feed(callbackUpdate(`task:comment:${task.id}`));
    await prisma.telegramPending.update({
      where: { chatId: BigInt(CHAT_ID) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const before = await prisma.comment.count({ where: { taskId: task.id } });
    const calls = await feed(textUpdate('This is far too late'));

    assert.match(allText(calls), /not expecting anything/i);
    assert.equal(
      await prisma.comment.count({ where: { taskId: task.id } }),
      before,
      'an expired draft must not file a comment',
    );
  });
});

// ---------------------------------------------------------------------------

describe('reporting an issue from Telegram', () => {
  it('walks project → description → severity → environment and files it', async () => {
    const start = allText(await feed(textUpdate('/report')));
    assert.match(start, /Which project/i);

    const chosen = allText(await feed(callbackUpdate(`report:project:${project.id}`)));
    assert.match(chosen, /describe the problem/i);

    const described = allText(
      await feed(textUpdate('Checkout fails on Safari\nOnly on iOS 17, every time.')),
    );
    assert.match(described, /How severe/i);

    const severity = allText(await feed(callbackUpdate('report:severity:CRITICAL')));
    assert.match(severity, /Where did it happen/i);

    const production = project.phases.find((phase) => phase.isProduction);
    const filed = allText(await feed(callbackUpdate(`report:phase:${production.id}`)));
    assert.match(filed, /Reported as/i);

    const created = await prisma.issue.findFirst({
      where: { projectId: project.id, title: 'Checkout fails on Safari' },
      include: { phase: true },
    });
    assert.ok(created, 'the issue should exist in the database');
    assert.equal(created.severity, 'CRITICAL');
    assert.equal(created.priority, 'CRITICAL', 'a critical report should be prioritised');
    assert.equal(created.description, 'Only on iOS 17, every time.');
    assert.equal(created.phase.isProduction, true);
    assert.equal(created.reporterId, adminUser.id);
    assert.equal(created.status, 'OPEN');
  });

  it('notifies the people who can act on a critical report', async () => {
    const created = await prisma.issue.findFirst({
      where: { projectId: project.id, title: 'Checkout fails on Safari' },
    });
    const notifications = await prisma.notification.findMany({
      where: { issueId: created.id, event: 'ISSUE_REPORTED' },
    });
    // The reporter is the only member here, and nobody is told about their own
    // report — so the fan-out correctly produces nothing to deliver.
    assert.ok(notifications.every((n) => n.userId !== adminUser.id));
  });

  it('expires a half-finished report rather than guessing', async () => {
    await feed(textUpdate('/report'));
    const cancelled = allText(await feed(textUpdate('/cancel')));
    assert.match(cancelled, /Cancelled/i);

    const stray = allText(await feed(textUpdate('this should go nowhere')));
    assert.ok(!/Reported as/i.test(stray));
  });
});

// ---------------------------------------------------------------------------

describe('finding and following work', () => {
  it('opens an item when its key is sent on its own', async () => {
    const reply = allText(await feed(textUpdate(task.key)));
    assert.ok(reply.includes(task.key.replace(/-/g, '\\-')), 'the card should name the task');
    assert.match(reply, /Status:/);
  });

  it('finds a key written inside a sentence', async () => {
    const reply = allText(await feed(textUpdate(`any news on ${task.key}?`)));
    assert.ok(reply.includes(task.key.replace(/-/g, '\\-')));
  });

  it('says so for a key that does not exist', async () => {
    const reply = allText(await feed(textUpdate('NOPE-404')));
    assert.match(reply, /could not find/i);
  });

  it('answers /app instead of failing to send', async () => {
    // This reply carried an unescaped full stop, so Telegram rejected it and
    // the command appeared to do nothing at all.
    const calls = await feed(textUpdate('/app'));
    assert.ok(texts(calls).length > 0, '/app must produce a message');
  });

  it('recognises every command it advertises', async () => {
    for (const { name } of ALL_COMMANDS) {
      const reply = allText(await feed(textUpdate(`/${name}`)));
      assert.doesNotMatch(reply, /Unknown command/i, `/${name} should be recognised`);
    }
  });

  it('explains itself in a group instead of offering a connection code', async () => {
    // Linking a group would let every member act as one person.
    const calls = await feed({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100123456, type: 'group', title: 'Team' },
        from: TELEGRAM_USER,
        text: '/mytasks',
        entities: [{ type: 'bot_command', offset: 0, length: 8 }],
      },
    });
    assert.match(allText(calls), /direct message/i);
  });

  it('stays out of ordinary group chatter', async () => {
    const calls = await feed({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100123456, type: 'group', title: 'Team' },
        from: TELEGRAM_USER,
        text: 'lunch?',
      },
    });
    assert.equal(texts(calls).length, 0, 'the bot should not answer group small talk');
  });

  it('does not claim to cancel something that was not running', async () => {
    await prisma.telegramPending.deleteMany({ where: { chatId: BigInt(CHAT_ID) } });
    const reply = allText(await feed(textUpdate('/cancel')));
    assert.match(reply, /nothing to cancel/i);
  });
});

// ---------------------------------------------------------------------------

describe('messages keep up with the work', () => {
  it('redraws the card when a button changes the status', async () => {
    const calls = await feed(callbackUpdate(`task:start:${task.id}`));
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.ok(edit, 'the message the button sits on should be rewritten');
    assert.ok(
      edit.payload.text.includes(task.key.replace(/-/g, '\\-')),
      'the rewritten message should still be about this task',
    );
  });

  it('will not let a decided hotfix be decided again', async () => {
    // It was approved earlier in this suite; a second tap from a stale message
    // must report what happened rather than overrule it.
    const reply = allText(await feed(callbackUpdate(`hotfix:reject:${hotfix.id}`)));
    assert.match(reply, /already/i);

    const after = await prisma.hotfix.findUnique({ where: { id: hotfix.id } });
    assert.equal(after.status, 'APPROVED', 'the first decision must stand');
  });
});

// ---------------------------------------------------------------------------

describe('permissions apply to the bot', () => {
  let viewer;
  let viewerChat;

  before(async () => {
    const roles = (await admin.get('/roles')).json.data;
    const email = `${unique('botviewer')}@example.com`;

    const invite = await admin.post('/users/invitations', {
      email,
      name: 'Bot Viewer',
      roleId: roles.find((role) => role.key === 'member').id,
      projectGrants: [{ projectId: project.id, roleId: roles.find((r) => r.key === 'viewer').id }],
    });
    const token = new URL(invite.json.acceptUrl).searchParams.get('token');

    const { createClient } = await import('./helpers.mjs');
    const client = createClient();
    const accepted = await client.post(
      '/auth/invitation/accept',
      { token, name: 'Bot Viewer', password: 'BotViewer12345' },
      { skipCsrf: true },
    );
    viewer = accepted.json.user;

    // Link a second chat to the Viewer account.
    viewerChat = CHAT_ID + 1;
    const { code } = (await client.post('/telegram/link-code')).json.data;
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: viewerChat, type: 'private', first_name: 'Viewer' },
        from: { id: viewerChat, is_bot: false, first_name: 'Viewer' },
        text: `/start ${code}`,
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    });
  });

  after(async () => {
    if (viewer) await admin.delete(`/users/${viewer.id}`);
  });

  it('linked the second account', async () => {
    const linked = await prisma.user.findFirst({ where: { telegramChatId: BigInt(viewerChat) } });
    assert.equal(linked?.id, viewer.id);
  });

  it('stops a Viewer changing a task status through the bot', async () => {
    const fresh = (
      await admin.post('/tasks', { projectId: project.id, title: 'Viewer must not move me' })
    ).json.data;

    sent = [];
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: String(updateId),
        from: { id: viewerChat, is_bot: false, first_name: 'Viewer' },
        chat_instance: '1',
        data: `task:start:${fresh.id}`,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat: { id: viewerChat, type: 'private', first_name: 'Viewer' },
          from: { id: 1, is_bot: true, first_name: 'KiriTask' },
          text: 'placeholder',
        },
      },
    });

    assert.match(alerts(sent).join(' '), /permission/i);

    const unchanged = await prisma.task.findUnique({
      where: { id: fresh.id },
      include: { status: true },
    });
    assert.notEqual(unchanged.status.category, 'IN_PROGRESS', 'the Viewer must not have moved it');
  });

  it('stops a Viewer reporting an issue they have no permission for', async () => {
    sent = [];
    await bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: viewerChat, type: 'private', first_name: 'Viewer' },
        from: { id: viewerChat, is_bot: false, first_name: 'Viewer' },
        text: '/report',
        entities: [{ type: 'bot_command', offset: 0, length: 7 }],
      },
    });
    assert.match(allText(sent), /do not have permission/i);
  });
});
