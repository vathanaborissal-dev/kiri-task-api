import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { prisma } from '../src/lib/prisma.ts';
import { createClient, signIn, unique } from './helpers.mjs';

/**
 * The daily plan — "Today" in the app — and the team view built on top of it.
 *
 *   npm run test:standup
 *
 * Two accounts take part: the administrator, who can see everyone, and a plain
 * member who can only see their own day.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

const MEMBER_PASSWORD = 'StandupMember123';

/** A day far enough from today that it cannot collide with seeded data. */
const FIXTURE_DAY = '2031-03-04';
const OTHER_DAY = '2031-03-05';

let admin;
let adminUser;
let member;
let memberUser;

const bodies = (plan, kind) =>
  plan.items.filter((item) => item.kind === kind).map((item) => item.body);

before(async () => {
  const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  admin = session.client;
  adminUser = session.user;

  const roles = (await admin.get('/roles')).json.data;
  const email = `${unique('standup')}@example.com`;
  const invite = await admin.post('/users/invitations', {
    email,
    name: 'Standup Member',
    roleId: roles.find((role) => role.key === 'member').id,
  });
  const token = new URL(invite.json.acceptUrl).searchParams.get('token');
  const client = createClient();
  const accepted = await client.post(
    '/auth/invitation/accept',
    { token, name: 'Standup Member', password: MEMBER_PASSWORD },
    { skipCsrf: true },
  );
  member = client;
  memberUser = accepted.json.user;
});

after(async () => {
  await prisma.dailyPlan.deleteMany({
    where: { userId: { in: [adminUser.id, memberUser.id].filter(Boolean) } },
    // Only the fixture days; the seeded team plans stay where they are.
  });
  if (memberUser) await admin.delete(`/users/${memberUser.id}`);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('my day', () => {
  it('hands back an empty plan for a day nobody has written yet', async () => {
    const response = await admin.get(`/standup/me?date=${FIXTURE_DAY}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.data.date, FIXTURE_DAY, 'the date comes back as a plain day key');
    assert.deepEqual(response.json.data.items, []);
    assert.equal(response.json.data.note, null);
  });

  it('refuses a date that is not a date', async () => {
    const response = await admin.get('/standup/me?date=last-tuesday');
    assert.equal(response.status, 400);
  });

  it('keeps focus and blockers apart', async () => {
    await admin.post('/standup/me/items', {
      date: FIXTURE_DAY,
      kind: 'FOCUS',
      body: 'Finish the settlement export',
    });
    const response = await admin.post('/standup/me/items', {
      date: FIXTURE_DAY,
      kind: 'BLOCKER',
      body: 'Waiting on a UAT account',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(bodies(response.json.data, 'FOCUS'), ['Finish the settlement export']);
    assert.deepEqual(bodies(response.json.data, 'BLOCKER'), ['Waiting on a UAT account']);
  });

  it('defaults a bullet with no kind to focus', async () => {
    const response = await admin.post('/standup/me/items', {
      date: OTHER_DAY,
      body: 'Something unlabelled',
    });
    assert.equal(response.json.data.items[0].kind, 'FOCUS');
  });

  it('writes each day separately', async () => {
    const day = await admin.get(`/standup/me?date=${FIXTURE_DAY}`);
    const other = await admin.get(`/standup/me?date=${OTHER_DAY}`);
    assert.equal(day.json.data.items.length, 2);
    assert.equal(other.json.data.items.length, 1);
  });

  it('ticks a focus bullet off', async () => {
    const plan = (await admin.get(`/standup/me?date=${FIXTURE_DAY}`)).json.data;
    const item = plan.items.find((entry) => entry.kind === 'FOCUS');

    const response = await admin.patch(`/standup/items/${item.id}`, { isDone: true });
    assert.equal(response.status, 200);
    assert.equal(
      response.json.data.items.find((entry) => entry.id === item.id).isDone,
      true,
    );
  });

  it('resolves a blocker with a timestamp rather than a flag on the wrong field', async () => {
    const plan = (await admin.get(`/standup/me?date=${FIXTURE_DAY}`)).json.data;
    const item = plan.items.find((entry) => entry.kind === 'BLOCKER');

    const resolved = await admin.patch(`/standup/items/${item.id}`, { resolved: true });
    const after = resolved.json.data.items.find((entry) => entry.id === item.id);
    assert.ok(after.resolvedAt, 'resolvedAt is set');
    assert.equal(after.isDone, false, 'a blocker is not "done", it is cleared');

    const reopened = await admin.patch(`/standup/items/${item.id}`, { resolved: false });
    assert.equal(
      reopened.json.data.items.find((entry) => entry.id === item.id).resolvedAt,
      null,
    );
  });

  it('saves and clears the note', async () => {
    const saved = await admin.put('/standup/me', {
      date: FIXTURE_DAY,
      note: '  Half day tomorrow.  ',
    });
    assert.equal(saved.json.data.note, 'Half day tomorrow.', 'the note is trimmed');

    const cleared = await admin.put('/standup/me', { date: FIXTURE_DAY, note: '   ' });
    assert.equal(cleared.json.data.note, null, 'whitespace clears it rather than storing blanks');
  });

  it('reorders bullets', async () => {
    const plan = (await admin.get(`/standup/me?date=${FIXTURE_DAY}`)).json.data;
    const focus = plan.items.filter((item) => item.kind === 'FOCUS');
    await admin.post('/standup/me/items', {
      date: FIXTURE_DAY,
      kind: 'FOCUS',
      body: 'Second focus',
    });

    const all = (await admin.get(`/standup/me?date=${FIXTURE_DAY}`)).json.data.items.filter(
      (item) => item.kind === 'FOCUS',
    );
    const reversed = [...all].reverse().map((item) => item.id);

    const response = await admin.post('/standup/me/items/reorder', { itemIds: reversed });
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.json.data.items.filter((item) => item.kind === 'FOCUS').map((item) => item.id),
      reversed,
    );
    assert.ok(focus.length >= 1);
  });

  it('rejects a bullet that is only whitespace', async () => {
    // zod runs its checks before the transform, so `.min(1).trim()` would let
    // "   " through and store a blank. The schema trims first.
    const response = await admin.post('/standup/me/items', { date: FIXTURE_DAY, body: '   ' });
    assert.equal(response.status, 422, JSON.stringify(response.json));
  });

  it('refuses a task the author cannot see', async () => {
    const response = await admin.post('/standup/me/items', {
      date: FIXTURE_DAY,
      body: 'Points at nothing',
      taskId: 'this-task-does-not-exist',
    });
    assert.equal(response.status, 404);
  });

  it('deletes a bullet', async () => {
    const plan = (await admin.get(`/standup/me?date=${OTHER_DAY}`)).json.data;
    const response = await admin.delete(`/standup/items/${plan.items[0].id}`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.data.items, []);
  });
});

describe('a day belongs to the person who wrote it', () => {
  it('stops anybody else editing a bullet, administrator included', async () => {
    const written = await member.post('/standup/me/items', {
      date: FIXTURE_DAY,
      body: 'Mine, not yours',
    });
    assert.equal(written.status, 201);
    const itemId = written.json.data.items[0].id;

    const edit = await admin.patch(`/standup/items/${itemId}`, { body: 'Rewritten by the boss' });
    assert.equal(edit.status, 403);

    const remove = await admin.delete(`/standup/items/${itemId}`);
    assert.equal(remove.status, 403);

    const still = await member.get(`/standup/me?date=${FIXTURE_DAY}`);
    assert.equal(still.json.data.items[0].body, 'Mine, not yours');
  });
});

describe('the team view', () => {
  it('shows everyone to somebody who can see the whole workspace', async () => {
    const response = await admin.get(`/standup/team?date=${FIXTURE_DAY}`);
    assert.equal(response.status, 200);
    assert.equal(response.json.data.date, FIXTURE_DAY);

    const names = response.json.data.people.map((entry) => entry.user.name);
    assert.ok(names.includes('Standup Member'), 'the member is listed');

    const mine = response.json.data.people.find((entry) => entry.user.id === memberUser.id);
    assert.equal(mine.plan.items[0].body, 'Mine, not yours');
  });

  it('lists people who have written nothing, with a null plan', async () => {
    const response = await admin.get('/standup/team?date=2031-01-01');
    assert.ok(response.json.data.people.length > 0);
    assert.ok(
      response.json.data.people.every((entry) => entry.plan === null),
      'nobody wrote anything that day',
    );
  });

  it('refuses a member who holds the permission nowhere', async () => {
    const response = await member.get(`/standup/team?date=${FIXTURE_DAY}`);
    assert.equal(response.status, 403);
  });

  it('tells the people who can help when somebody writes down a blocker', async () => {
    const before = await prisma.notification.count({
      where: { userId: adminUser.id, event: 'STANDUP_BLOCKER' },
    });

    await member.post('/standup/me/items', {
      date: FIXTURE_DAY,
      kind: 'BLOCKER',
      body: 'Nobody has given me database access',
    });

    const after = await prisma.notification.findMany({
      where: { userId: adminUser.id, event: 'STANDUP_BLOCKER' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });

    assert.equal(
      await prisma.notification.count({
        where: { userId: adminUser.id, event: 'STANDUP_BLOCKER' },
      }),
      before + 1,
    );
    assert.match(after[0].title, /Standup Member is blocked/);
    assert.equal(after[0].body, 'Nobody has given me database access');
  });

  it('does not raise a notification for ordinary focus work', async () => {
    const before = await prisma.notification.count({
      where: { userId: adminUser.id, event: 'STANDUP_BLOCKER' },
    });

    await member.post('/standup/me/items', {
      date: FIXTURE_DAY,
      kind: 'FOCUS',
      body: 'Quietly getting on with it',
    });

    assert.equal(
      await prisma.notification.count({
        where: { userId: adminUser.id, event: 'STANDUP_BLOCKER' },
      }),
      before,
    );
  });
});

describe("what's new and the guide", () => {
  it('starts unseen and records both', async () => {
    const before = (await admin.get('/auth/me')).json.user;
    assert.ok('changelogSeenAt' in before, 'the client is told what it has read');

    const response = await admin.post('/auth/me/seen', { changelog: true, guide: true });
    assert.equal(response.status, 200);
    assert.ok(response.json.user.changelogSeenAt);
    assert.ok(response.json.user.guideSeenAt);
  });

  it('leaves the other one alone when only one is marked', async () => {
    await prisma.user.update({
      where: { id: adminUser.id },
      data: { changelogSeenAt: null, guideSeenAt: null },
    });

    const response = await admin.post('/auth/me/seen', { changelog: true });
    assert.ok(response.json.user.changelogSeenAt);
    assert.equal(response.json.user.guideSeenAt, null);
  });
});
