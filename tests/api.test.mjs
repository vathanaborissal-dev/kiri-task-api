import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { API, ORIGIN, createClient, signIn, unique } from './helpers.mjs';

/**
 * End-to-end tests against a running API and a real database.
 *
 *   npm run dev          # in one terminal
 *   npm test             # in another
 *
 * Everything created here is deleted in the `after` hooks, so the suite is
 * safe to run repeatedly against a development workspace.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error(
    'Set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD (or SEED_ADMIN_*) before running the tests.',
  );
}

let admin;
let adminUser;
let project;
let roles;
/** A throwaway account, so the credential tests never spend the administrator's
 *  rate-limit budget — the limiter buckets by IP and email. */
let scratch;

before(async () => {
  const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  admin = session.client;
  adminUser = session.user;

  roles = (await admin.get('/roles')).json.data;

  const scratchEmail = `${unique('scratch')}@example.com`;
  const invite = await admin.post('/users/invitations', {
    email: scratchEmail,
    name: 'Scratch Account',
    roleId: roles.find((role) => role.key === 'guest').id,
  });
  const scratchToken = new URL(invite.json.acceptUrl).searchParams.get('token');
  const scratchClient = createClient();
  const accepted = await scratchClient.post(
    '/auth/invitation/accept',
    { token: scratchToken, name: 'Scratch Account', password: 'ScratchAccount123' },
    { skipCsrf: true },
  );
  scratch = { email: scratchEmail, password: 'ScratchAccount123', user: accepted.json.user };

  const key = `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const created = await admin.post('/projects', {
    name: `Test project ${key}`,
    key,
    description: 'Created by the end-to-end suite.',
    status: 'ACTIVE',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = (await admin.get(`/projects/${created.json.data.key}`)).json.data;
});

after(async () => {
  if (project) await admin.delete(`/projects/${project.key}`, { confirm: project.key });
  if (scratch?.user) await admin.delete(`/users/${scratch.user.id}`);
});

// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('rejects a wrong password with the same message as an unknown email', async () => {
    const anon = createClient();
    const wrongPassword = await anon.post(
      '/auth/login',
      { email: scratch.email, password: 'definitely-not-it' },
      { skipCsrf: true },
    );
    const unknownEmail = await anon.post(
      '/auth/login',
      { email: 'nobody@example.com', password: 'definitely-not-it' },
      { skipCsrf: true },
    );

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, 401);
    assert.equal(wrongPassword.json.error.message, unknownEmail.json.error.message);
  });

  it('returns the session, its projects and the unread count', async () => {
    const me = await admin.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.json.user.email, ADMIN_EMAIL.toLowerCase());
    assert.ok(Array.isArray(me.json.projects));
    assert.equal(typeof me.json.unreadNotifications, 'number');
  });

  it('rotates the refresh token and revokes the family when one is replayed', async () => {
    const { client } = await signIn(scratch.email, scratch.password);
    const stolen = client.jar.get('kiri_rt');

    const first = await client.post('/auth/refresh');
    assert.equal(first.status, 200);
    assert.notEqual(client.jar.get('kiri_rt'), stolen, 'refresh token should rotate');

    // Replaying the old token looks like a leak, so the whole chain dies.
    const replay = createClient();
    replay.jar.set('kiri_rt', stolen);
    const replayed = await replay.post('/auth/refresh');
    assert.equal(replayed.status, 401);

    const afterReplay = await client.post('/auth/refresh');
    assert.equal(afterReplay.status, 401, 'the rotated token should be revoked too');
  });

  it('blocks a mutating request without the CSRF header', async () => {
    const blocked = await admin.post(
      '/tasks',
      { projectId: project.id, title: 'no csrf' },
      { skipCsrf: true },
    );
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'FORBIDDEN');
  });

  it('rejects an origin that is not on the allowlist', async () => {
    const blocked = await admin.get('/projects', { origin: 'https://evil.example' });
    assert.equal(blocked.status, 403);
  });

  it('lists active sessions and marks the current one', async () => {
    const sessions = await admin.get('/auth/sessions');
    assert.equal(sessions.status, 200);
    assert.ok(sessions.json.data.some((session) => session.isCurrent));
  });

  it('does not reveal whether an email exists when asked for a reset', async () => {
    const anon = createClient();
    const known = await anon.post('/auth/forgot-password', { email: scratch.email }, { skipCsrf: true });
    const unknown = await anon.post(
      '/auth/forgot-password',
      { email: 'nobody@example.com' },
      { skipCsrf: true },
    );
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.equal(known.json.message, unknown.json.message);
  });
});

// ---------------------------------------------------------------------------

describe('roles and permissions', () => {
  let customRole;

  after(async () => {
    if (customRole) await admin.delete(`/roles/${customRole.id}`);
  });

  it('serves a permission catalogue grouped for the editor', async () => {
    const catalogue = await admin.get('/roles/permissions');
    assert.equal(catalogue.status, 200);
    assert.ok(catalogue.json.groups.length > 0);
    const keys = catalogue.json.groups.flatMap((group) => group.permissions.map((p) => p.key));
    assert.ok(keys.includes('task:create'));
    assert.ok(keys.includes('role:update'));
  });

  it('creates a custom role and grants it permissions', async () => {
    const created = await admin.post('/roles', {
      name: unique('Release Captain'),
      scope: 'PROJECT',
      permissions: ['project:view', 'release:view', 'release:create'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    customRole = created.json.data;

    const updated = await admin.patch(`/roles/${customRole.id}`, {
      permissions: ['project:view', 'release:view', 'release:create', 'release:deploy'],
    });
    assert.equal(updated.status, 200);
    assert.ok(updated.json.data.permissions.includes('release:deploy'));
  });

  it('refuses to strip full access from the Administrator role', async () => {
    const administrator = roles.find((role) => role.key === 'administrator');
    const attempt = await admin.patch(`/roles/${administrator.id}`, {
      permissions: ['user:view'],
    });
    assert.equal(attempt.status, 400);
  });

  it('refuses to delete a built-in role', async () => {
    const developer = roles.find((role) => role.key === 'developer');
    const attempt = await admin.delete(`/roles/${developer.id}`);
    assert.equal(attempt.status, 400);
  });
});

// ---------------------------------------------------------------------------

describe('project-scoped permissions', () => {
  let tester;
  let testerUser;
  let secondProject;
  let testerTask;

  before(async () => {
    const memberRole = roles.find((role) => role.key === 'member');
    const developerRole = roles.find((role) => role.key === 'developer');
    const viewerRole = roles.find((role) => role.key === 'viewer');

    const second = await admin.post('/projects', {
      name: `Second project ${Date.now().toString(36)}`,
      key: `S${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    secondProject = second.json.data;

    const email = `${unique('tester')}@example.com`;
    const invite = await admin.post('/users/invitations', {
      email,
      name: 'Suite Tester',
      roleId: memberRole.id,
      projectGrants: [
        { projectId: project.id, roleId: developerRole.id },
        { projectId: secondProject.id, roleId: viewerRole.id },
      ],
    });
    assert.equal(invite.status, 201, JSON.stringify(invite.json));

    const token = new URL(invite.json.acceptUrl).searchParams.get('token');
    tester = createClient();
    const accepted = await tester.post(
      '/auth/invitation/accept',
      { token, name: 'Suite Tester', password: 'SuiteTester123' },
      { skipCsrf: true },
    );
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    testerUser = accepted.json.user;
  });

  after(async () => {
    // The tester reported a task, and a reporter cannot be deleted while that
    // task exists — so the work goes first.
    if (testerTask) await admin.delete(`/tasks/${testerTask.key}`);
    if (testerUser) await admin.delete(`/users/${testerUser.id}`);
    if (secondProject) {
      await admin.delete(`/projects/${secondProject.key}`, { confirm: secondProject.key });
    }
  });

  it('gives the invited person the project roles from the invitation', async () => {
    const me = await tester.get('/auth/me');
    const byKey = Object.fromEntries(me.json.projects.map((p) => [p.key, p.role.key]));
    assert.equal(byKey[project.key], 'developer');
    assert.equal(byKey[secondProject.key], 'viewer');
  });

  it('lets a Developer create a task on their project', async () => {
    const created = await tester.post('/tasks', {
      projectId: project.id,
      title: 'Written by the Developer',
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    testerTask = created.json.data;
  });

  it('stops a Viewer creating a task on the other project', async () => {
    const blocked = await tester.post('/tasks', {
      projectId: secondProject.id,
      title: 'Should never exist',
    });
    assert.equal(blocked.status, 403);
  });

  it('still lets the Viewer read that project', async () => {
    const readable = await tester.get(`/projects/${secondProject.key}`);
    assert.equal(readable.status, 200);
  });

  it('stops a Developer assigning work to somebody else', async () => {
    const blocked = await tester.patch(`/tasks/${testerTask.key}`, {
      assigneeIds: [adminUser.id],
    });
    assert.equal(blocked.status, 403);
  });

  it('stops a Developer setting a deadline', async () => {
    const blocked = await tester.patch(`/tasks/${testerTask.key}`, {
      dueDate: '2027-01-01T00:00:00.000Z',
    });
    assert.equal(blocked.status, 403);
  });

  it('lets a Developer move their task between statuses', async () => {
    const inProgress = project.statuses.find((status) => status.category === 'IN_PROGRESS');
    const moved = await tester.post(`/tasks/${testerTask.key}/move`, { statusId: inProgress.id });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.data.status.id, inProgress.id);
  });

  it('hides a project the person is not a member of behind a 404', async () => {
    const secret = await admin.post('/projects', {
      name: 'Secret initiative',
      key: `X${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    const invisible = await tester.get(`/projects/${secret.json.data.id}`);
    assert.equal(invisible.status, 404, 'existence must not leak as a 403');

    const list = (await tester.get('/projects')).json.data.map((p) => p.key);
    assert.ok(!list.includes(secret.json.data.key));

    await admin.delete(`/projects/${secret.json.data.key}`, { confirm: secret.json.data.key });
  });

  it('stops a Member touching workspace administration', async () => {
    const role = await tester.post('/roles', { name: 'Nope', scope: 'GLOBAL', permissions: [] });
    assert.equal(role.status, 403);

    const invite = await tester.post('/users/invitations', {
      email: 'x@example.com',
      roleId: roles[0].id,
    });
    assert.equal(invite.status, 403);
  });

  it('explains what is in the way instead of failing on a foreign key', async () => {
    // The tester reported a task above, and a reporter has to stay answerable.
    const refused = await admin.delete(`/users/${testerUser.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error.message, /history that has to be kept/i);
    assert.match(refused.json.error.message, /Deactivate the account instead/i);
    assert.ok(refused.json.error.details.blocking, 'the counts should say what blocks it');
  });

  it('deletes somebody who never did anything', async () => {
    const roles2 = (await admin.get('/roles')).json.data;
    const invite = await admin.post('/users/invitations', {
      email: `${unique('ghost')}@example.com`,
      roleId: roles2.find((role) => role.key === 'guest').id,
    });
    const token = new URL(invite.json.acceptUrl).searchParams.get('token');

    const ghostClient = createClient();
    const ghost = await ghostClient.post(
      '/auth/invitation/accept',
      { token, name: 'Passing Ghost', password: 'GhostAccount123' },
      { skipCsrf: true },
    );

    const removed = await admin.delete(`/users/${ghost.json.user.id}`);
    assert.equal(removed.status, 204, JSON.stringify(removed.json));
  });

  it('locks a deactivated account out immediately', async () => {
    const deactivated = await admin.patch(`/users/${testerUser.id}`, { isActive: false });
    assert.equal(deactivated.status, 200);

    const locked = await tester.get('/auth/me');
    assert.equal(locked.status, 401);

    await admin.patch(`/users/${testerUser.id}`, { isActive: true });
  });
});

// ---------------------------------------------------------------------------

describe('tasks', () => {
  let task;
  let subtask;

  it('creates a task with a checklist and the default status', async () => {
    const created = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Ship the reporting export',
      description: 'CSV and PDF, behind the report:view permission.',
      type: 'FEATURE',
      priority: 'HIGH',
      dueDate: '2027-03-01T09:00:00.000Z',
      estimateHours: 6,
      checklist: ['Design the query', 'Add the endpoint', 'Wire the button'],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    task = created.json.data;

    assert.match(task.key, new RegExp(`^${project.key}-\\d+$`));
    assert.equal(task.checklist.length, 3);
    assert.equal(task.status.id, project.statuses.find((s) => s.isDefault).id);
  });

  it('assigns people and labels', async () => {
    const label = project.labels[0];
    const updated = await admin.patch(`/tasks/${task.key}`, {
      assigneeIds: [adminUser.id],
      labelIds: [label.id],
    });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.json.data.assignees.map((a) => a.id), [adminUser.id]);
    assert.deepEqual(updated.json.data.labels.map((l) => l.id), [label.id]);
  });

  it('tracks work status, phase and testing separately', async () => {
    const uat = project.phases.find((phase) => phase.key === 'uat');
    const review = project.statuses.find((status) => status.category === 'IN_REVIEW');

    const updated = await admin.patch(`/tasks/${task.key}`, {
      statusId: review.id,
      phaseId: uat.id,
      qaStatus: 'IN_TESTING',
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.status.category, 'IN_REVIEW');
    assert.equal(updated.json.data.phase.key, 'uat');
    assert.equal(updated.json.data.qaStatus, 'IN_TESTING');
  });

  it('stamps completedAt when the task reaches a Done status', async () => {
    const done = project.statuses.find((status) => status.category === 'DONE');
    const finished = await admin.patch(`/tasks/${task.key}`, { statusId: done.id });
    assert.ok(finished.json.data.completedAt, 'completedAt should be set');

    const todo = project.statuses.find((status) => status.isDefault);
    const reopened = await admin.patch(`/tasks/${task.key}`, { statusId: todo.id });
    assert.equal(reopened.json.data.completedAt, null, 'and cleared again on reopen');
  });

  it('creates a subtask and refuses to nest a third level', async () => {
    const created = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Design the query',
      parentTaskId: task.id,
    });
    assert.equal(created.status, 201);
    subtask = created.json.data;

    const tooDeep = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Too deep',
      parentTaskId: subtask.id,
    });
    assert.equal(tooDeep.status, 400);
  });

  it('manages the checklist', async () => {
    const added = await admin.post(`/tasks/${task.key}/checklist`, { title: 'Write the docs' });
    assert.equal(added.status, 201);

    const ticked = await admin.patch(`/tasks/${task.key}/checklist/${added.json.data.id}`, {
      isDone: true,
    });
    assert.equal(ticked.status, 200);
    assert.ok(ticked.json.data.completedAt);

    const removed = await admin.delete(`/tasks/${task.key}/checklist/${added.json.data.id}`);
    assert.equal(removed.status, 204);
  });

  it('links tasks to each other', async () => {
    const linked = await admin.post(`/tasks/${task.key}/links`, {
      targetTaskId: subtask.key,
      type: 'RELATES_TO',
    });
    assert.equal(linked.status, 201);

    const detail = await admin.get(`/tasks/${task.key}`);
    assert.ok(detail.json.data.links.some((link) => link.task.key === subtask.key));

    const removed = await admin.delete(`/tasks/${task.key}/links/${linked.json.data.id}`);
    assert.equal(removed.status, 204);
  });

  it('refuses to link a task to itself', async () => {
    const blocked = await admin.post(`/tasks/${task.key}/links`, {
      targetTaskId: task.key,
      type: 'RELATES_TO',
    });
    assert.equal(blocked.status, 400);
  });

  it('refuses a status from another project', async () => {
    const other = await admin.post('/projects', {
      name: 'Scope check',
      key: `C${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    const otherProject = (await admin.get(`/projects/${other.json.data.key}`)).json.data;

    const blocked = await admin.patch(`/tasks/${task.key}`, {
      statusId: otherProject.statuses[0].id,
    });
    assert.equal(blocked.status, 400);

    await admin.delete(`/projects/${otherProject.key}`, { confirm: otherProject.key });
  });

  it('returns a board grouped by status', async () => {
    const board = await admin.get(`/tasks/board?projectId=${project.id}`);
    assert.equal(board.status, 200);
    assert.equal(board.json.data.length, project.statuses.length);
    assert.ok(board.json.data.every((column) => Array.isArray(column.tasks)));
  });

  it('filters, groups and sorts', async () => {
    const overdue = await admin.get(`/tasks?projectId=${project.id}&overdue=true`);
    assert.equal(overdue.status, 200);

    const grouped = await admin.get(`/tasks?projectId=${project.id}&groupBy=status`);
    assert.equal(grouped.status, 200);
    assert.equal(grouped.json.meta.grouped, true);

    const highOnly = await admin.get(`/tasks?projectId=${project.id}&priority=HIGH`);
    assert.ok(highOnly.json.data.every((t) => t.priority === 'HIGH'));
  });

  it('updates many tasks at once', async () => {
    const blocked = project.statuses.find((status) => status.category === 'BLOCKED');
    const result = await admin.post('/tasks/bulk', {
      taskIds: [task.id, subtask.id],
      statusId: blocked.id,
      priority: 'CRITICAL',
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.updated, 2);

    const reread = await admin.get(`/tasks/${task.key}`);
    assert.equal(reread.json.data.status.category, 'BLOCKED');
    assert.equal(reread.json.data.priority, 'CRITICAL');
  });

  it('toggles watching', async () => {
    const off = await admin.post(`/tasks/${task.key}/watch`);
    assert.equal(off.json.watching, false);
    const on = await admin.post(`/tasks/${task.key}/watch`);
    assert.equal(on.json.watching, true);
  });

  it('serves the calendar feed', async () => {
    const schedule = await admin.get('/tasks/schedule');
    assert.equal(schedule.status, 200);
    assert.ok(Array.isArray(schedule.json.data.tasks));
    assert.ok(Array.isArray(schedule.json.data.milestones));
    assert.ok(Array.isArray(schedule.json.data.releases));
  });

  it('deletes a task and its subtasks', async () => {
    const removed = await admin.delete(`/tasks/${task.key}`);
    assert.equal(removed.status, 204);

    const gone = await admin.get(`/tasks/${subtask.key}`);
    assert.equal(gone.status, 404, 'subtasks should go with the parent');
  });
});

// ---------------------------------------------------------------------------

describe('issues, releases and hotfixes', () => {
  let issue;
  let fixTask;
  let release;
  let hotfix;

  it('reports an issue against an environment', async () => {
    const uat = project.phases.find((phase) => phase.key === 'uat');
    const created = await admin.post('/issues', {
      projectId: project.id,
      title: 'Export times out on large projects',
      description: 'Anything over ~5k rows never returns.',
      stepsToReproduce: '1. Open reports\n2. Export a project with 5k tasks',
      expectedResult: 'A CSV downloads',
      actualResult: 'The request hangs, then 504',
      severity: 'CRITICAL',
      phaseId: uat.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    issue = created.json.data;

    assert.match(issue.key, new RegExp(`^${project.key}-I\\d+$`));
    assert.equal(issue.status, 'OPEN');
    assert.equal(issue.phase.key, 'uat');
  });

  it('walks the issue through its workflow and counts reopens', async () => {
    const steps = ['ASSIGNED', 'IN_PROGRESS', 'READY_FOR_TESTING', 'RESOLVED'];
    for (const status of steps) {
      const moved = await admin.post(`/issues/${issue.key}/status`, { status });
      assert.equal(moved.status, 200, `could not move to ${status}`);
      assert.equal(moved.json.data.status, status);
    }

    const resolved = await admin.get(`/issues/${issue.key}`);
    assert.ok(resolved.json.data.resolvedAt);

    const reopened = await admin.post(`/issues/${issue.key}/status`, {
      status: 'REOPENED',
      comment: 'Still happening on 10k rows.',
    });
    assert.equal(reopened.json.data.reopenCount, 1);
    assert.equal(reopened.json.data.resolvedAt, null);

    const closed = await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });
    assert.ok(closed.json.data.closedAt);

    await admin.post(`/issues/${issue.key}/status`, { status: 'IN_PROGRESS' });
  });

  it('creates the task that carries the fix and links it back', async () => {
    const created = await admin.post(`/issues/${issue.key}/create-task`);
    assert.equal(created.status, 201, JSON.stringify(created.json));
    fixTask = created.json.data;

    const reread = await admin.get(`/issues/${issue.key}`);
    assert.equal(reread.json.data.task.key, fixTask.key);

    const second = await admin.post(`/issues/${issue.key}/create-task`);
    assert.equal(second.status, 400, 'an issue should only carry one fix task');
  });

  it('creates a release and scopes work into it', async () => {
    const created = await admin.post('/releases', {
      projectId: project.id,
      version: '2.1.0',
      name: 'Reporting fixes',
      status: 'IN_DEVELOPMENT',
      taskIds: [fixTask.id],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    release = created.json.data;

    const detail = await admin.get(`/releases/${release.id}`);
    assert.equal(detail.json.data.tasks.length, 1);
    assert.ok(detail.json.data.readiness, 'readiness summary should be present');
  });

  it('promotes every task in the release when it is deployed', async () => {
    const uat = project.phases.find((phase) => phase.key === 'uat');
    const deployed = await admin.post(`/releases/${release.id}/deployments`, {
      phaseId: uat.id,
      notes: 'Deployed to UAT for verification.',
    });
    assert.equal(deployed.status, 201, JSON.stringify(deployed.json));

    const promoted = await admin.get(`/tasks/${fixTask.key}`);
    assert.equal(promoted.json.data.phase.key, 'uat', 'the task should follow the release');
  });

  it('marks the release shipped when it reaches production', async () => {
    const production = project.phases.find((phase) => phase.isProduction);
    await admin.post(`/releases/${release.id}/deployments`, { phaseId: production.id });

    const shipped = await admin.get(`/releases/${release.id}`);
    assert.equal(shipped.json.data.status, 'RELEASED');
    assert.ok(shipped.json.data.releasedAt);
    assert.equal(shipped.json.data.phase.isProduction, true);
  });

  it('does not walk a release backwards through the phases', async () => {
    const development = project.phases.find((phase) => phase.key === 'development');
    await admin.post(`/releases/${release.id}/deployments`, { phaseId: development.id });

    const stillLive = await admin.get(`/releases/${release.id}`);
    assert.equal(
      stillLive.json.data.phase.isProduction,
      true,
      'a redeploy to an earlier phase must not demote the release',
    );
  });

  it('refuses a phase from another project', async () => {
    const other = await admin.post('/projects', {
      name: 'Phase scope check',
      key: `P${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    const otherProject = (await admin.get(`/projects/${other.json.data.key}`)).json.data;

    const blocked = await admin.post(`/releases/${release.id}/deployments`, {
      phaseId: otherProject.phases[0].id,
    });
    assert.equal(blocked.status, 400);

    await admin.delete(`/projects/${otherProject.key}`, { confirm: otherProject.key });
  });

  it('raises a hotfix from the issue and creates its task', async () => {
    const created = await admin.post('/hotfixes', {
      projectId: project.id,
      title: 'Patch the export timeout',
      description: 'Customers cannot export at all.',
      issueId: issue.id,
      severity: 'BLOCKER',
      assigneeId: adminUser.id,
      createTask: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    hotfix = created.json.data;

    assert.match(hotfix.key, new RegExp(`^${project.key}-HF\\d+$`));
    assert.equal(hotfix.status, 'REQUESTED');
    assert.ok(hotfix.task, 'a linked task should be created');
    assert.equal(hotfix.task.qaStatus, 'PENDING');
    assert.equal(hotfix.issue.key, issue.key);
  });

  it('records the approval and stamps the timeline', async () => {
    const approved = await admin.post(`/hotfixes/${hotfix.key}/decision`, {
      approve: true,
      comment: 'Go ahead, ship tonight.',
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.data.status, 'APPROVED');
    assert.ok(approved.json.data.approvedAt);
  });

  it('stamps each later stage of the hotfix as it progresses', async () => {
    const stages = [
      ['IN_PROGRESS', null],
      ['READY', 'fixedAt'],
      ['IN_TESTING', 'testedAt'],
      ['DEPLOYED', 'deployedAt'],
      ['VERIFIED', 'verifiedAt'],
    ];

    for (const [status, stamp] of stages) {
      const moved = await admin.patch(`/hotfixes/${hotfix.key}`, { status });
      assert.equal(moved.status, 200, `could not move to ${status}`);
      if (stamp) assert.ok(moved.json.data[stamp], `${stamp} should be set at ${status}`);
    }

    const recorded = await admin.patch(`/hotfixes/${hotfix.key}`, {
      releaseId: release.id,
      rootCause: 'Unbounded query with no pagination.',
      resolution: 'Added a cursor and a hard limit.',
    });
    assert.equal(recorded.json.data.release.version, '2.1.0');
  });

  it('lists only open hotfixes when asked', async () => {
    const open = await admin.get(`/hotfixes?projectId=${project.id}&openOnly=true`);
    assert.equal(open.status, 200);
    assert.ok(
      open.json.data.every((item) => !['DEPLOYED', 'VERIFIED', 'REJECTED'].includes(item.status)),
    );
  });

  it('shows the phase board with QA and issue counts', async () => {
    const board = await admin.get(`/releases/phase-board?projectId=${project.id}`);
    assert.equal(board.status, 200);
    assert.equal(board.json.data.phases.length, project.phases.length);
    const uat = board.json.data.phases.find((entry) => entry.phase.key === 'uat');
    assert.equal(typeof uat.stats.openIssues, 'number');
    assert.equal(typeof uat.stats.awaitingTesting, 'number');
  });
});

// ---------------------------------------------------------------------------

describe('collaboration', () => {
  let task;
  let comment;
  let attachmentId;

  before(async () => {
    const created = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Collaboration fixture',
    });
    task = created.json.data;
  });

  it('posts a comment with an @mention', async () => {
    const created = await admin.post('/comments', {
      taskId: task.id,
      body: 'Taking this one, @Workspace Admin — shout if that clashes.',
      mentionUserIds: [adminUser.id],
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    comment = created.json.data;
    assert.equal(comment.mentions.length, 1);
  });

  it('only lets project members be mentioned', async () => {
    const outsider = await admin.post('/comments', {
      taskId: task.id,
      body: 'Mentioning a stranger',
      mentionUserIds: ['definitely-not-a-member'],
    });
    assert.equal(outsider.status, 201);
    assert.equal(outsider.json.data.mentions.length, 0, 'unknown ids are dropped, not trusted');
  });

  it('edits and deletes a comment', async () => {
    const edited = await admin.patch(`/comments/${comment.id}`, { body: 'Actually, picked up.' });
    assert.equal(edited.status, 200);
    assert.ok(edited.json.data.editedAt);

    const removed = await admin.delete(`/comments/${comment.id}`);
    assert.equal(removed.status, 204);
  });

  it('lists the people who can be mentioned on a project', async () => {
    const people = await admin.get(`/comments/mentionables?projectId=${project.id}`);
    assert.equal(people.status, 200);
    assert.ok(people.json.data.every((person) => person.roleName));
  });

  it('uploads an attachment to Cloudinary and serves it back', async () => {
    // A 1×1 transparent PNG — small enough to post inline, real enough to store.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('files', new Blob([png], { type: 'image/png' }), 'pixel.png');
    form.append('taskId', task.id);

    const uploaded = await admin.post('/attachments', undefined, { formData: form });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.json));

    const [file] = uploaded.json.data;
    attachmentId = file.id;
    assert.match(file.url, /^https:\/\/res\.cloudinary\.com\//);
    assert.equal(file.mimeType, 'image/png');

    const fetched = await fetch(file.url);
    assert.equal(fetched.status, 200, 'the stored file should be publicly readable');

    const detail = await admin.get(`/tasks/${task.key}`);
    assert.equal(detail.json.data.attachments.length, 1);
  });

  it('rejects a file type that is not on the allowlist', async () => {
    const form = new FormData();
    form.append('files', new Blob([Buffer.from('#!/bin/sh\necho hi')], { type: 'application/x-sh' }), 'run.sh');
    form.append('taskId', task.id);

    const blocked = await admin.post('/attachments', undefined, { formData: form });
    assert.equal(blocked.status, 400);
  });

  it('deletes an attachment', async () => {
    const removed = await admin.delete(`/attachments/${attachmentId}`);
    assert.equal(removed.status, 204);
  });

  it('writes a readable activity trail for the task', async () => {
    const activity = await admin.get(`/activity?taskId=${task.key}`);
    assert.equal(activity.status, 200);
    const actions = activity.json.data.map((entry) => entry.action);
    assert.ok(actions.includes('task.created'));
    assert.ok(actions.includes('comment.created'));
  });

  it('serves the workspace audit log to an administrator', async () => {
    const audit = await admin.get('/activity/audit?pageSize=5');
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.json.data));
  });
});

// ---------------------------------------------------------------------------

describe('notifications', () => {
  it('lists notifications with an unread count', async () => {
    const list = await admin.get('/notifications');
    assert.equal(list.status, 200);
    assert.equal(typeof list.json.unread, 'number');
  });

  it('serves every event with its per-channel preference', async () => {
    const prefs = await admin.get('/notifications/preferences');
    assert.equal(prefs.status, 200);
    assert.ok(prefs.json.data.length > 10);
    const mention = prefs.json.data.find((pref) => pref.event === 'MENTION');
    assert.equal(mention.web, true);
    assert.equal(typeof mention.telegram, 'boolean');
  });

  it('saves a changed preference', async () => {
    const saved = await admin.put('/notifications/preferences', {
      settings: [{ event: 'TASK_DUE_SOON', email: true }],
    });
    assert.equal(saved.status, 200);

    const reread = await admin.get('/notifications/preferences');
    const dueSoon = reread.json.data.find((pref) => pref.event === 'TASK_DUE_SOON');
    assert.equal(dueSoon.email, true);

    await admin.put('/notifications/preferences', {
      settings: [{ event: 'TASK_DUE_SOON', email: false }],
    });
  });

  it('marks everything read', async () => {
    const read = await admin.post('/notifications/read', { all: true });
    assert.equal(read.status, 200);
    assert.equal(read.json.unread, 0);
  });

  it('streams server-sent events to the signed-in user', async () => {
    const controller = new AbortController();
    const response = await fetch(`${API}/notifications/stream`, {
      headers: {
        origin: ORIGIN,
        cookie: [...admin.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /connected|ping/);
    controller.abort();
  });
});

// ---------------------------------------------------------------------------

describe('reporting', () => {
  it('summarises everything the caller can see', async () => {
    const overview = await admin.get('/dashboard/overview');
    assert.equal(overview.status, 200);
    const { totals } = overview.json.data;
    assert.equal(typeof totals.projects, 'number');
    assert.equal(typeof totals.openIssues, 'number');
    assert.equal(typeof totals.progress, 'number');
    assert.ok(totals.progress >= 0 && totals.progress <= 100);
  });

  it('answers what one person has to do', async () => {
    const mine = await admin.get('/dashboard/my-work');
    assert.equal(mine.status, 200);
    assert.ok(Array.isArray(mine.json.data.tasks));
    assert.equal(typeof mine.json.data.counts.overdue, 'number');
  });

  it('breaks a project down by status, phase, testing and workload', async () => {
    const report = await admin.get(`/dashboard/projects/${project.id}`);
    assert.equal(report.status, 200);
    const data = report.json.data;
    assert.equal(data.statusBreakdown.length, project.statuses.length);
    assert.ok(data.phaseBreakdown.some((phase) => phase.id === 'none'));
    assert.ok(Array.isArray(data.workload));
    assert.ok(Array.isArray(data.velocity));
  });

  it('reports workload per person', async () => {
    const workload = await admin.get('/users/workload');
    assert.equal(workload.status, 200);
    assert.ok(workload.json.data.every((row) => typeof row.openTasks === 'number'));
  });
});

// ---------------------------------------------------------------------------

describe('project configuration', () => {
  it('adds, renames and removes a board column, moving its tasks', async () => {
    const created = await admin.post(`/projects/${project.key}/statuses`, {
      name: 'Waiting on customer',
      category: 'BLOCKED',
      color: '#f59e0b',
    });
    assert.equal(created.status, 201);
    const status = created.json.data;

    const renamed = await admin.patch(`/projects/${project.key}/statuses/${status.id}`, {
      name: 'Waiting on client',
    });
    assert.equal(renamed.json.data.name, 'Waiting on client');

    const parked = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Parked task',
      statusId: status.id,
    });

    const refused = await admin.delete(`/projects/${project.key}/statuses/${status.id}`);
    assert.equal(refused.status, 409, 'deleting a column with tasks needs a destination');

    const fallback = project.statuses.find((s) => s.isDefault);
    const removed = await admin.delete(`/projects/${project.key}/statuses/${status.id}`, {
      moveToStatusId: fallback.id,
    });
    assert.equal(removed.status, 204);

    const moved = await admin.get(`/tasks/${parked.json.data.key}`);
    assert.equal(moved.json.data.status.id, fallback.id);
    await admin.delete(`/tasks/${parked.json.data.key}`);
  });

  it('keeps exactly one production phase', async () => {
    const pilot = project.phases.find((phase) => phase.key === 'pilot');
    await admin.patch(`/projects/${project.key}/phases/${pilot.id}`, { isProduction: true });

    const reread = await admin.get(`/projects/${project.key}`);
    const production = reread.json.data.phases.filter((phase) => phase.isProduction);
    assert.equal(production.length, 1);
    assert.equal(production[0].key, 'pilot');

    const original = project.phases.find((phase) => phase.isProduction);
    await admin.patch(`/projects/${project.key}/phases/${original.id}`, { isProduction: true });
  });

  it('refuses to delete a phase that is still referenced', async () => {
    const uat = project.phases.find((phase) => phase.key === 'uat');
    const parked = await admin.post('/tasks', {
      projectId: project.id,
      title: 'Phase holder',
      phaseId: uat.id,
    });

    const refused = await admin.delete(`/projects/${project.key}/phases/${uat.id}`);
    assert.equal(refused.status, 409);

    await admin.delete(`/tasks/${parked.json.data.key}`);
  });

  it('manages labels and milestones', async () => {
    const label = await admin.post(`/projects/${project.key}/labels`, {
      name: unique('perf'),
      color: '#22c55e',
    });
    assert.equal(label.status, 201);
    assert.equal((await admin.delete(`/projects/${project.key}/labels/${label.json.data.id}`)).status, 204);

    const milestone = await admin.post(`/projects/${project.key}/milestones`, {
      name: 'Beta',
      dueDate: '2027-06-30T00:00:00.000Z',
    });
    assert.equal(milestone.status, 201);

    const completed = await admin.patch(
      `/projects/${project.key}/milestones/${milestone.json.data.id}`,
      { completed: true },
    );
    assert.ok(completed.json.data.completedAt);

    assert.equal(
      (await admin.delete(`/projects/${project.key}/milestones/${milestone.json.data.id}`)).status,
      204,
    );
  });

  it('archives and restores a project', async () => {
    const archived = await admin.post(`/projects/${project.key}/archive`, { restore: false });
    assert.equal(archived.status, 200);
    assert.equal(archived.json.data.status, 'ARCHIVED');

    const hiddenProjects = await admin.get('/projects?includeArchived=false');
    assert.equal(
      hiddenProjects.json.data.some((item) => item.id === project.id),
      false,
      'includeArchived=false should hide archived projects',
    );

    const visibleProjects = await admin.get('/projects?includeArchived=true');
    assert.equal(
      visibleProjects.json.data.some((item) => item.id === project.id),
      true,
      'includeArchived=true should include archived projects',
    );

    assert.equal(
      (await admin.get('/auth/me')).json.projects.some((item) => item.id === project.id),
      false,
    );

    const restored = await admin.post(`/projects/${project.key}/archive`, { restore: true });
    assert.equal(restored.json.data.status, 'ACTIVE');
    assert.equal(restored.json.data.archivedAt, null);
    assert.equal(
      (await admin.get('/auth/me')).json.projects.some((item) => item.id === project.id),
      true,
    );
  });

  it('requires the project code to confirm a delete', async () => {
    const refused = await admin.delete(`/projects/${project.key}`, { confirm: 'wrong' });
    assert.equal(refused.status, 400);
  });

  it('deletes a project that still has work in it', async () => {
    // Tasks need a status and deployments need a phase, and both are cascade
    // deleted with the project — so the order has to be right or Postgres
    // refuses the whole thing.
    const created = await admin.post('/projects', {
      name: 'Delete me with work inside',
      key: `D${Date.now().toString(36).slice(-5).toUpperCase()}`,
    });
    const doomed = (await admin.get(`/projects/${created.json.data.key}`)).json.data;

    const task = await admin.post('/tasks', { projectId: doomed.id, title: 'Some work' });
    const release = await admin.post('/releases', {
      projectId: doomed.id,
      version: '0.1.0',
      taskIds: [task.json.data.id],
    });
    await admin.post(`/releases/${release.json.data.id}/deployments`, {
      phaseId: doomed.phases[0].id,
    });
    await admin.post('/issues', { projectId: doomed.id, title: 'Something broke' });

    const removed = await admin.delete(`/projects/${doomed.key}`, { confirm: doomed.key });
    assert.equal(removed.status, 204, JSON.stringify(removed.json));

    const gone = await admin.get(`/projects/${doomed.key}`);
    assert.equal(gone.status, 404);
  });

  it('saves and reuses a filter', async () => {
    const saved = await admin.post('/filters', {
      name: unique('My critical work'),
      scope: 'TASK',
      projectId: project.id,
      query: { priority: ['CRITICAL'], includeDone: false },
    });
    assert.equal(saved.status, 201);

    const list = await admin.get(`/filters?scope=TASK&projectId=${project.id}`);
    assert.ok(list.json.data.some((filter) => filter.id === saved.json.data.id));

    assert.equal((await admin.delete(`/filters/${saved.json.data.id}`)).status, 204);
  });
});

// ---------------------------------------------------------------------------

describe('telegram linking', () => {
  it('reports the bot status', async () => {
    const status = await admin.get('/telegram/status');
    assert.equal(status.status, 200);
    assert.equal(typeof status.json.data.botConfigured, 'boolean');
  });

  it('issues a single-use code with a deep link', async () => {
    const created = await admin.post('/telegram/link-code');
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const { code, deepLink, expiresInMinutes } = created.json.data;

    assert.match(code, /^[A-Z0-9]{8}$/);
    assert.ok(deepLink.includes(code));
    assert.ok(expiresInMinutes > 0 && expiresInMinutes <= 30);
  });

  it('replaces the previous code when a new one is asked for', async () => {
    const first = (await admin.post('/telegram/link-code')).json.data.code;
    const second = (await admin.post('/telegram/link-code')).json.data.code;
    assert.notEqual(first, second);
  });
});
