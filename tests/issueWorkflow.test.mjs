import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ISSUE_TRANSITIONS,
  SETTLED_ISSUE_STATUSES,
  allowedTransitions,
  isSettled,
  refuseTransition,
  transitionTable,
} from '../src/modules/issues/issueWorkflow.ts';
import { progressForStatus } from '../src/modules/tasks/tasks.service.ts';

/**
 * The issue workflow is a pure table, so it is tested without a database.
 *
 *   npm run test:workflow
 */

/** Somebody who holds every permission. */
const admin = () => true;
/** A developer: can change status, but cannot assign, close or reopen. */
const developer = (permission) => permission === 'issue:change_status';

describe('no going back down', () => {
  for (const settled of SETTLED_ISSUE_STATUSES) {
    it(`refuses ${settled} → In Progress and names the reopen`, () => {
      const refusal = refuseTransition(settled, 'IN_PROGRESS', admin);
      assert.ok(refusal, 'expected a refusal');
      assert.equal(refusal.code, 'NOT_ALLOWED');
      assert.match(refusal.message, /reopened first/i);
    });

    it(`lets ${settled} reach Reopened`, () => {
      assert.equal(refuseTransition(settled, 'REOPENED', admin), null);
    });
  }

  it('refuses In Progress → Open, so picking an issue up is not undone silently', () => {
    const refusal = refuseTransition('IN_PROGRESS', 'OPEN', admin);
    assert.ok(refusal);
    assert.equal(refusal.code, 'NOT_ALLOWED');
  });

  it('allows Ready for Testing → In Progress, because failing a test is not a reopen', () => {
    assert.equal(refuseTransition('READY_FOR_TESTING', 'IN_PROGRESS', admin), null);
  });

  it('treats a move to the same status as a no-op rather than an error', () => {
    assert.equal(refuseTransition('CLOSED', 'CLOSED', developer), null);
  });
});

describe('role gates', () => {
  it('lets anyone who can change status start work', () => {
    assert.equal(refuseTransition('OPEN', 'IN_PROGRESS', developer), null);
  });

  it('refuses assigning without issue:assign, and says who can', () => {
    const refusal = refuseTransition('OPEN', 'ASSIGNED', developer);
    assert.ok(refusal);
    assert.equal(refusal.code, 'NEEDS_PERMISSION');
    assert.match(refusal.message, /project manager, team lead or issue manager/i);
  });

  it('refuses closing without issue:close', () => {
    assert.equal(refuseTransition('RESOLVED', 'CLOSED', developer).code, 'NEEDS_PERMISSION');
  });

  it("refuses won't-fix without issue:close", () => {
    assert.equal(refuseTransition('OPEN', 'WONT_FIX', developer).code, 'NEEDS_PERMISSION');
  });

  it('refuses reopening without issue:reopen', () => {
    assert.equal(refuseTransition('CLOSED', 'REOPENED', developer).code, 'NEEDS_PERMISSION');
  });

  it('allows all of it for a lead', () => {
    const lead = (permission) =>
      ['issue:change_status', 'issue:assign', 'issue:close', 'issue:reopen'].includes(permission);
    assert.equal(refuseTransition('OPEN', 'ASSIGNED', lead), null);
    assert.equal(refuseTransition('RESOLVED', 'CLOSED', lead), null);
    assert.equal(refuseTransition('CLOSED', 'REOPENED', lead), null);
  });
});

describe('allowedTransitions', () => {
  it('hides the moves a developer cannot make', () => {
    assert.deepEqual(allowedTransitions('OPEN', developer), ['IN_PROGRESS']);
  });

  it('offers a lead everything the table lists', () => {
    assert.deepEqual(allowedTransitions('OPEN', admin), [
      'ASSIGNED',
      'IN_PROGRESS',
      'CLOSED',
      'WONT_FIX',
    ]);
  });

  it('leaves a developer no way out of a closed issue', () => {
    assert.deepEqual(allowedTransitions('CLOSED', developer), []);
  });

  it('never offers a transition the guard would then refuse', () => {
    for (const from of Object.keys(ISSUE_TRANSITIONS)) {
      for (const to of allowedTransitions(from, developer)) {
        assert.equal(
          refuseTransition(from, to, developer),
          null,
          `${from} → ${to} was offered but refused`,
        );
      }
    }
  });
});

describe('the table itself', () => {
  it('has an exit from every status, so nothing is a dead end', () => {
    for (const [from, transitions] of Object.entries(ISSUE_TRANSITIONS)) {
      assert.ok(transitions.length > 0, `${from} has no way out`);
    }
  });

  it('never lists a status as a transition to itself', () => {
    for (const [from, transitions] of Object.entries(ISSUE_TRANSITIONS)) {
      assert.ok(!transitions.some((t) => t.to === from), `${from} points at itself`);
    }
  });

  it('marks exactly the settled statuses as settled', () => {
    for (const row of transitionTable()) {
      assert.equal(row.settled, isSettled(row.from), `${row.from} settled flag is wrong`);
    }
  });

  it('renders a label for every status it names', () => {
    for (const row of transitionTable()) {
      assert.ok(row.fromLabel, `${row.from} has no label`);
      for (const target of row.to) assert.ok(target.label, `${target.status} has no label`);
    }
  });
});

describe('task progress follows the status column', () => {
  it('forces 100 when the task lands in a Done column', () => {
    assert.equal(progressForStatus('DONE', 40, 40), 100);
    assert.equal(progressForStatus('DONE', undefined, 0), 100);
  });

  it('caps a non-done status below 100, so the board and the number agree', () => {
    assert.equal(progressForStatus('IN_PROGRESS', 100, 0), 99);
    assert.equal(progressForStatus('TODO', 60, 0), 60);
  });

  it('steps a finished task back when it leaves the Done column', () => {
    assert.equal(progressForStatus('IN_PROGRESS', undefined, 100), 90);
  });

  it('leaves an unfinished task alone when only the status moved', () => {
    assert.equal(progressForStatus('IN_PROGRESS', undefined, 45), undefined);
  });

  it('does not touch the number when work is cancelled', () => {
    assert.equal(progressForStatus('CANCELED', undefined, 70), undefined);
  });
});
