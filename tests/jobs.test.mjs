import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { runDeadlineSweep } from '../src/jobs/deadlines.ts';
import { registerTelegramSender } from '../src/services/channels.ts';
import { notify, telegramButtonUrl } from '../src/services/notifications.ts';
import { prisma } from '../src/lib/prisma.ts';
import { signIn, unique } from './helpers.mjs';

/**
 * Covers the parts that never go through an HTTP route: the notification
 * fan-out, the Telegram transport registry and the nightly deadline sweep.
 *
 *   npm run test:jobs
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

const CHAT_ID = 9_000_000_777;

let admin;
let adminUser;
let project;
let telegramOut = [];
let originalTelegram;
let originalNotificationSettings = [];

const hours = (n) => new Date(Date.now() + n * 60 * 60 * 1000);

before(async () => {
  const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  admin = session.client;
  adminUser = session.user;

  [originalTelegram, originalNotificationSettings] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: adminUser.id },
      select: {
        telegramChatId: true,
        telegramUsername: true,
        telegramLinkedAt: true,
      },
    }),
    prisma.notificationSetting.findMany({ where: { userId: adminUser.id } }),
  ]);

  const key = `J${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const created = await admin.post('/projects', { name: `Jobs test ${key}`, key });
  project = (await admin.get(`/projects/${created.json.data.key}`)).json.data;

  // Capture anything bound for Telegram instead of sending it.
  registerTelegramSender(async (message) => {
    telegramOut.push(message);
  });

  // The suite only checks Telegram and in-app delivery. Never send a real
  // email while exercising the shared development account.
  await prisma.notificationSetting.upsert({
    where: { userId_event: { userId: adminUser.id, event: 'MENTION' } },
    create: {
      userId: adminUser.id,
      event: 'MENTION',
      web: true,
      telegram: true,
      email: false,
    },
    update: { web: true, telegram: true, email: false },
  });
});

after(async () => {
  await prisma.user.update({
    where: { id: adminUser.id },
    data: originalTelegram,
  });
  await prisma.notificationSetting.deleteMany({ where: { userId: adminUser.id } });
  if (originalNotificationSettings.length) {
    await prisma.notificationSetting.createMany({
      data: originalNotificationSettings.map(({ id: _id, ...setting }) => setting),
    });
  }
  if (project) await admin.delete(`/projects/${project.key}`, { confirm: project.key });
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('notification fan-out', () => {
  it('never tells somebody about their own action', async () => {
    const before = await prisma.notification.count({ where: { userId: adminUser.id } });
    await notify({
      userIds: [adminUser.id],
      actorId: adminUser.id,
      event: 'TASK_ASSIGNED',
      title: 'You did this yourself',
    });
    const after = await prisma.notification.count({ where: { userId: adminUser.id } });
    assert.equal(after, before, 'the actor should be filtered out');
  });

  it('writes an in-app notification for everyone else', async () => {
    // A unique title per run, so an earlier run's (already read) copy cannot
    // be the one this assertion picks up.
    const title = unique('Fan-out test');
    await notify({
      userIds: [adminUser.id],
      event: 'TASK_ASSIGNED',
      title,
      body: 'Written by the jobs suite.',
      url: '/my-work',
    });

    const written = await prisma.notification.findFirst({ where: { userId: adminUser.id, title } });
    assert.ok(written);
    assert.equal(written.url, '/my-work');
    assert.equal(written.readAt, null);
  });

  it('sends to Telegram once the account is linked', async () => {
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { telegramChatId: BigInt(CHAT_ID) },
    });

    telegramOut = [];
    await notify({
      userIds: [adminUser.id],
      event: 'MENTION',
      title: 'Telegram delivery test',
      body: 'Should reach the chat.',
      url: '/my-work',
    });

    assert.equal(telegramOut.length, 1, 'exactly one Telegram message');
    assert.equal(telegramOut[0].chatId, BigInt(CHAT_ID));
    assert.match(telegramOut[0].text, /Telegram delivery test/);
    const linkButton = telegramOut[0].buttons?.flat().find((button) => button.url || button.webApp);
    assert.equal(linkButton, undefined, 'Telegram must not receive a localhost button');
  });

  it('only puts public web links into Telegram buttons', () => {
    assert.equal(telegramButtonUrl('http://localhost:3100/my-work'), undefined);
    assert.equal(telegramButtonUrl('http://192.168.0.10:3100/my-work'), undefined);
    assert.equal(
      telegramButtonUrl('https://tasks.example.com/my-work'),
      'https://tasks.example.com/my-work',
    );
  });

  it('still sends task assignments when the web link is local', async () => {
    const created = await admin.post('/tasks', {
      projectId: project.id,
      title: unique('Telegram link label'),
    });
    const task = created.json.data;

    telegramOut = [];
    await notify({
      userIds: [adminUser.id],
      event: 'TASK_ASSIGNED',
      title: 'A task was assigned to you',
      url: `/projects/${project.key}/tasks/${task.key}`,
      taskId: task.id,
    });

    assert.equal(
      Boolean(telegramOut[0].buttons?.flat().some((button) => button.url || button.webApp)),
      false,
      'a local task link must not make Telegram reject the entire assignment message',
    );
  });

  it('escapes Markdown so a stray underscore cannot break the message', async () => {
    telegramOut = [];
    await notify({
      userIds: [adminUser.id],
      event: 'MENTION',
      title: 'Fix snake_case in *bold* [brackets]',
    });
    assert.match(telegramOut[0].text, /snake\\_case/);
    assert.match(telegramOut[0].text, /\\\*bold\\\*/);
  });

  it('respects a per-event preference', async () => {
    await prisma.notificationSetting.upsert({
      where: { userId_event: { userId: adminUser.id, event: 'TASK_OVERDUE' } },
      create: { userId: adminUser.id, event: 'TASK_OVERDUE', web: false, telegram: false },
      update: { web: false, telegram: false },
    });

    telegramOut = [];
    const before = await prisma.notification.count({ where: { userId: adminUser.id } });

    await notify({
      userIds: [adminUser.id],
      event: 'TASK_OVERDUE',
      title: 'Should be suppressed everywhere',
    });

    const after = await prisma.notification.count({ where: { userId: adminUser.id } });
    assert.equal(after, before, 'web was switched off');
    assert.equal(telegramOut.length, 0, 'telegram was switched off');

    await prisma.notificationSetting.deleteMany({
      where: { userId: adminUser.id, event: 'TASK_OVERDUE' },
    });
  });

  it('skips a deactivated account', async () => {
    const before = await prisma.notification.count();
    await notify({
      userIds: ['a-user-id-that-does-not-exist'],
      event: 'TASK_ASSIGNED',
      title: 'Nobody home',
    });
    assert.equal(await prisma.notification.count(), before);
  });
});

// ---------------------------------------------------------------------------

describe('deadline sweep', () => {
  let dueSoon;
  let overdue;

  before(async () => {
    dueSoon = (
      await admin.post('/tasks', {
        projectId: project.id,
        title: 'Due in a few hours',
        assigneeIds: [adminUser.id],
        dueDate: hours(6).toISOString(),
      })
    ).json.data;

    overdue = (
      await admin.post('/tasks', {
        projectId: project.id,
        title: 'Slipped yesterday',
        assigneeIds: [adminUser.id],
        dueDate: hours(-30).toISOString(),
      })
    ).json.data;

    // The sweep has no actor, so these reminders do reach the assignee.
    await prisma.notification.deleteMany({
      where: { userId: adminUser.id, taskId: { in: [dueSoon.id, overdue.id] } },
    });
  });

  it('warns about work due in the next day and work that has slipped', async () => {
    const result = await runDeadlineSweep();
    assert.ok(result.dueSoonTasks >= 1, 'the task due in six hours should be found');
    assert.ok(result.overdueTasks >= 1, 'the task that slipped should be found');

    const warned = await prisma.notification.findFirst({
      where: { userId: adminUser.id, taskId: dueSoon.id, event: 'TASK_DUE_SOON' },
    });
    assert.ok(warned, 'a due-soon reminder should exist');
    assert.match(warned.title, /due/i);

    const late = await prisma.notification.findFirst({
      where: { userId: adminUser.id, taskId: overdue.id, event: 'TASK_OVERDUE' },
    });
    assert.ok(late, 'an overdue warning should exist');
  });

  it('carries Telegram buttons so the task can be moved from the reminder', async () => {
    // Scoped to this run's own tasks: another suite against the same database
    // must not be able to make this pass or fail.
    await prisma.notification.deleteMany({
      where: { userId: adminUser.id, taskId: { in: [dueSoon.id, overdue.id] } },
    });
    telegramOut = [];

    await runDeadlineSweep();

    // Matched on the callback data, not the text — MarkdownV2 escaping means
    // the key reads as `ABC\-1` in the message body.
    const reminder = telegramOut.find((message) =>
      message.buttons?.flat().some((button) => button.callbackData === `task:start:${dueSoon.id}`),
    );
    assert.ok(reminder, `a reminder for ${dueSoon.key} should reach Telegram`);
    assert.match(reminder.text, /due/i);

    const callbacks = reminder.buttons.flat().map((button) => button.callbackData ?? '');
    assert.ok(callbacks.includes(`task:done:${dueSoon.id}`), 'and offer to finish it');
  });

  it('does not send the same reminder twice in a day', async () => {
    const forThisRun = { userId: adminUser.id, taskId: { in: [dueSoon.id, overdue.id] } };
    const before = await prisma.notification.count({ where: forThisRun });

    await runDeadlineSweep();

    const after = await prisma.notification.count({ where: forThisRun });
    assert.equal(after, before, 'a second sweep in the same window must be a no-op');
  });

  it('leaves finished work alone', async () => {
    const done = project.statuses.find((status) => status.category === 'DONE');
    await admin.patch(`/tasks/${overdue.key}`, { statusId: done.id });

    await prisma.notification.deleteMany({ where: { userId: adminUser.id, taskId: overdue.id } });
    await runDeadlineSweep();

    const warned = await prisma.notification.findFirst({
      where: { userId: adminUser.id, taskId: overdue.id, event: 'TASK_OVERDUE' },
    });
    assert.equal(warned, null, 'a completed task is not overdue');
  });
});
