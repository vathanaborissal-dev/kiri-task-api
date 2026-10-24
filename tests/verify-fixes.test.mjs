import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signIn, unique } from './helpers.mjs';

/**
 * End-to-end checks for the issue/task workflow changes, against a running API
 * and a real database.
 *
 *   npm run dev            # in one terminal
 *   npm run test:fixes     # in another
 *
 * Everything it creates is deleted in `after`.
 */

const EMAIL = process.env.TEST_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

if (!EMAIL || !PASSWORD) throw new Error('Set TEST_ADMIN_* or SEED_ADMIN_* in .env');

let admin;
let adminUserId;
let project;
let statuses;
let inProgressStatus;
let doneStatus;
let todoStatus;

before(async () => {
  const session = await signIn(EMAIL, PASSWORD);
  admin = session.client;
  adminUserId = session.user.id;

  const key = `V${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const created = await admin.post('/projects', {
    name: `Verify ${unique('fixes')}`,
    key,
    status: 'ACTIVE',
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  project = created.json.data;

  const detail = (await admin.get(`/projects/${project.key}`)).json.data;
  statuses = detail.statuses;
  todoStatus = statuses.find((s) => s.category === 'TODO');
  inProgressStatus = statuses.find((s) => s.category === 'IN_PROGRESS');
  doneStatus = statuses.find((s) => s.category === 'DONE');
  assert.ok(todoStatus && inProgressStatus && doneStatus, 'project needs TODO/IN_PROGRESS/DONE');
});

after(async () => {
  // The delete endpoint wants the project code typed back as confirmation;
  // without it this swallowed a 400 and left a project behind on every run.
  if (!project) return;
  const removed = await admin.delete(`/projects/${project.id}`, { confirm: project.key });
  if (removed.status !== 204) {
    console.error(`[cleanup] could not delete ${project.key}: ${removed.status}`);
  }
});

const newIssue = async (over = {}) =>
  admin
    .post('/issues', {
      projectId: project.id,
      title: `Issue ${unique('v')}`,
      severity: 'MAJOR',
      ...over,
    })
    .then((r) => r.json.data);

// --- 1. Start and end dates on an issue -----------------------------------

describe('issue start and end dates', () => {
  it('stores both, and returns them', async () => {
    const issue = await newIssue({
      startDate: '2026-11-03T00:00:00.000Z',
      dueDate: '2026-11-17T00:00:00.000Z',
    });
    assert.equal(issue.startDate?.slice(0, 10), '2026-11-03');
    assert.equal(issue.dueDate?.slice(0, 10), '2026-11-17');
  });

  it('refuses an end date before the start date', async () => {
    const response = await admin.post('/issues', {
      projectId: project.id,
      title: `Backwards ${unique('v')}`,
      startDate: '2026-11-17T00:00:00.000Z',
      dueDate: '2026-11-03T00:00:00.000Z',
    });
    assert.equal(response.status, 400);
  });

  it('can be edited afterwards', async () => {
    const issue = await newIssue();
    const updated = await admin
      .patch(`/issues/${issue.key}`, { startDate: '2026-12-01T00:00:00.000Z' })
      .then((r) => r.json.data);
    assert.equal(updated.startDate?.slice(0, 10), '2026-12-01');
  });
});

// --- 2. Status transition validity ----------------------------------------

describe('issue status transitions', () => {
  it('serves the workflow table', async () => {
    const { json: body } = await admin.get('/issues/workflow');
    const closed = body.data.find((row) => row.from === 'CLOSED');
    assert.deepEqual(
      closed.to.map((t) => t.status),
      ['REOPENED'],
      'a closed issue may only be reopened',
    );
    assert.equal(closed.settled, true);
  });

  it('serves the moves available on one issue', async () => {
    const issue = await newIssue();
    const { json: body } = await admin.get(`/issues/${issue.key}/transitions`);
    assert.equal(body.data.status, 'OPEN');
    assert.ok(body.data.allowed.includes('IN_PROGRESS'));
    assert.ok(!body.data.allowed.includes('RESOLVED'), 'Open cannot jump straight to Resolved');
  });

  it('refuses a closed issue going straight back to In Progress', async () => {
    const issue = await newIssue();
    await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });

    const response = await admin.post(`/issues/${issue.key}/status`, { status: 'IN_PROGRESS' });
    assert.equal(response.status, 409, 'should be a conflict, not a permission error');
    assert.match(response.json.error.message, /reopened first/i);
  });

  it('allows it once the issue has been reopened, and counts the reopen', async () => {
    const issue = await newIssue();
    await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });
    await admin.post(`/issues/${issue.key}/status`, { status: 'REOPENED' });

    const response = await admin.post(`/issues/${issue.key}/status`, { status: 'IN_PROGRESS' });
    assert.equal(response.status, 200);
    assert.equal(response.json.data.status, 'IN_PROGRESS');
    assert.equal(response.json.data.reopenCount, 1);
  });

  it('refuses the same illegal move through the PATCH route', async () => {
    const issue = await newIssue();
    await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });

    const response = await admin.patch(`/issues/${issue.key}`, { status: 'IN_PROGRESS' });
    assert.equal(response.status, 409, 'PATCH must enforce the same table as /status');
  });

  it('does not let an assignee change quietly override an explicit status', async () => {
    const issue = await newIssue();
    const updated = await admin
      .patch(`/issues/${issue.key}`, { status: 'IN_PROGRESS', assigneeId: adminUserId })
      .then((r) => r.json.data);
    assert.equal(updated.status, 'IN_PROGRESS', 'the named status wins over the assign side-effect');
  });
});

// --- 3 & 6. One issue, many tasks; and the two statuses stay in step ------

describe('an issue holds many tasks', () => {
  it('accepts more than one, and lists them all', async () => {
    const issue = await newIssue();

    const first = await admin
      .post(`/issues/${issue.key}/create-task`, { title: 'Write the migration' })
      .then((r) => r.json.data);
    const second = await admin
      .post(`/issues/${issue.key}/create-task`, { title: 'Fix the handler' })
      .then((r) => r.json.data);

    const detail = await admin.get(`/issues/${issue.key}`).then((r) => r.json.data);
    const keys = detail.tasks.map((t) => t.key);
    assert.ok(keys.includes(first.key) && keys.includes(second.key));
    assert.equal(detail.counts.tasks, 2);
    assert.equal(detail.task.key, first.key, 'the first task stays the primary fix');
  });

  it('rolls task progress up into the issue', async () => {
    const issue = await newIssue();
    const a = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);
    const b = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);

    await admin.patch(`/tasks/${a.key}`, { progress: 50 });
    await admin.patch(`/tasks/${b.key}`, { progress: 100 });

    const detail = await admin.get(`/issues/${issue.key}`).then((r) => r.json.data);
    // 100 is capped to 99 outside a Done column, so 50 and 99 average to 75 (rounded).
    assert.equal(detail.taskProgress.total, 2);
    assert.ok(
      detail.taskProgress.percent >= 74 && detail.taskProgress.percent <= 75,
      `expected ~75, got ${detail.taskProgress.percent}`,
    );
  });

  it('carries the issue forward when a task starts, and again when all finish', async () => {
    const issue = await newIssue();
    const task = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);

    await admin.patch(`/tasks/${task.key}`, { statusId: inProgressStatus.id });
    let detail = await admin.get(`/issues/${issue.key}`).then((r) => r.json.data);
    assert.equal(detail.status, 'IN_PROGRESS', 'starting a task starts the issue');

    await admin.patch(`/tasks/${task.key}`, { statusId: doneStatus.id });
    detail = await admin.get(`/issues/${issue.key}`).then((r) => r.json.data);
    assert.equal(detail.status, 'READY_FOR_TESTING', 'finishing the last task sends it to testing');
  });

  it('freezes a settled issue’s tasks until it is reopened', async () => {
    const issue = await newIssue();
    const task = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);
    await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });

    const refused = await admin.patch(`/tasks/${task.key}`, { statusId: inProgressStatus.id });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error.message, /reopen/i);

    // And the drag-and-drop route is gated too, not just the form.
    const refusedMove = await admin.post(`/tasks/${task.key}/move`, {
      statusId: inProgressStatus.id,
    });
    assert.equal(refusedMove.status, 409, 'the board must enforce it as well');

    await admin.post(`/issues/${issue.key}/status`, { status: 'REOPENED' });
    const allowed = await admin.patch(`/tasks/${task.key}`, { statusId: inProgressStatus.id });
    assert.equal(allowed.status, 200);
  });

  it('cancels unfinished tasks when an issue is dismissed', async () => {
    const issue = await newIssue();
    const task = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);

    await admin.post(`/issues/${issue.key}/status`, { status: 'WONT_FIX' });
    const after = await admin.get(`/tasks/${task.key}`).then((r) => r.json.data);
    assert.equal(after.status.category, 'CANCELED');
  });
});

// --- 5. Task completed percentage ----------------------------------------

describe('task progress', () => {
  const newTask = async (over = {}) =>
    admin
      .post('/tasks', { projectId: project.id, title: `Task ${unique('v')}`, ...over })
      .then((r) => r.json.data);

  it('starts at zero and can be set', async () => {
    const task = await newTask();
    assert.equal(task.progress, 0);

    const updated = await admin.patch(`/tasks/${task.key}`, { progress: 40 });
    assert.equal(updated.json.data.progress, 40);
  });

  it('is forced to 100 by a Done column', async () => {
    const task = await newTask();
    const updated = await admin.patch(`/tasks/${task.key}`, { statusId: doneStatus.id });
    assert.equal(updated.json.data.progress, 100);
  });

  it('cannot claim 100 while the card is not in a Done column', async () => {
    const task = await newTask();
    const updated = await admin.patch(`/tasks/${task.key}`, { progress: 100 });
    assert.equal(updated.json.data.progress, 99, 'capped, so the board and the number agree');
  });

  it('steps back below the line when a finished task is reopened', async () => {
    const task = await newTask();
    await admin.patch(`/tasks/${task.key}`, { statusId: doneStatus.id });
    const moved = await admin.patch(`/tasks/${task.key}`, { statusId: todoStatus.id });
    assert.equal(moved.json.data.progress, 90);
  });

  it('is set to 100 by a drag onto the Done column too', async () => {
    const task = await newTask();
    const moved = await admin.post(`/tasks/${task.key}/move`, { statusId: doneStatus.id });
    assert.equal(moved.json.data.progress, 100);
  });

  it('rejects a percentage outside 0-100', async () => {
    const task = await newTask();
    const response = await admin.patch(`/tasks/${task.key}`, { progress: 140 });
    assert.equal(response.status, 422);
  });
});

// --- 4. A second developer helping on a task ------------------------------

describe('asking for help on a task', () => {
  it('adds somebody and returns them as an assignee', async () => {
    const task = await admin
      .post('/tasks', { projectId: project.id, title: `Helper ${unique('v')}` })
      .then((r) => r.json.data);

    const response = await admin.post(`/tasks/${task.key}/helpers`, {
      userId: adminUserId,
      note: 'Second pair of eyes please',
    });
    assert.equal(response.status, 201);
    assert.ok(response.json.data.assignees.some((a) => a.id === adminUserId));
  });

  it('refuses to add the same person twice', async () => {
    const task = await admin
      .post('/tasks', { projectId: project.id, title: `Helper ${unique('v')}` })
      .then((r) => r.json.data);
    await admin.post(`/tasks/${task.key}/helpers`, { userId: adminUserId });

    const again = await admin.post(`/tasks/${task.key}/helpers`, { userId: adminUserId });
    assert.equal(again.status, 400);
  });

  it('removes them again', async () => {
    const task = await admin
      .post('/tasks', { projectId: project.id, title: `Helper ${unique('v')}` })
      .then((r) => r.json.data);
    await admin.post(`/tasks/${task.key}/helpers`, { userId: adminUserId });

    const removed = await admin.delete(`/tasks/${task.key}/helpers/${adminUserId}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.data.assignees.length, 0);
  });
});

// --- 8. Multi-select bulk updates -----------------------------------------

describe('bulk updates', () => {
  it('sets progress across several tasks at once', async () => {
    // Sequential, not Promise.all: two tasks created in the same project at
    // the same instant collide on the project's key counter and the second
    // loses with a P2028. See "Known limits" — it predates these changes.
    const made = [];
    for (const _ of [1, 2, 3]) {
      const created = await admin.post('/tasks', {
        projectId: project.id,
        title: `Bulk ${unique('bulk')}`,
      });
      assert.equal(created.status, 201, JSON.stringify(created.json));
      made.push(created.json.data);
    }

    const response = await admin.post('/tasks/bulk', {
      taskIds: made.map((t) => t.id),
      progress: 75,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.updated, 3);

    for (const task of made) {
      const after = await admin.get(`/tasks/${task.key}`).then((r) => r.json.data);
      assert.equal(after.progress, 75);
    }
  });

  it('changes several issues at once', async () => {
    const made = [await newIssue(), await newIssue()];

    const response = await admin.post('/issues/bulk', {
      issueIds: made.map((i) => i.id),
      severity: 'CRITICAL',
      status: 'IN_PROGRESS',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.updated, 2);

    for (const issue of made) {
      const after = await admin.get(`/issues/${issue.key}`).then((r) => r.json.data);
      assert.equal(after.severity, 'CRITICAL');
      assert.equal(after.status, 'IN_PROGRESS');
    }
  });

  it('refuses the whole batch when one issue cannot make the move', async () => {
    const open = await newIssue();
    const closed = await newIssue();
    await admin.post(`/issues/${closed.key}/status`, { status: 'CLOSED' });

    const response = await admin.post('/issues/bulk', {
      issueIds: [open.id, closed.id],
      status: 'IN_PROGRESS',
    });
    assert.equal(response.status, 409);

    // Nothing was written: the open issue must not have moved either.
    const after = await admin.get(`/issues/${open.key}`).then((r) => r.json.data);
    assert.equal(after.status, 'OPEN', 'a refused batch must be all-or-nothing');
  });

  it('refuses a bulk task move that a settled issue blocks', async () => {
    const issue = await newIssue();
    const task = await admin.post(`/issues/${issue.key}/create-task`, {}).then((r) => r.json.data);
    await admin.post(`/issues/${issue.key}/status`, { status: 'CLOSED' });

    const response = await admin.post('/tasks/bulk', {
      taskIds: [task.id],
      statusId: inProgressStatus.id,
    });
    assert.equal(response.status, 409);
  });
});
