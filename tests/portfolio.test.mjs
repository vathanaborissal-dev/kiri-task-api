import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessRisk, byRisk, mondayOf, weekBuckets } from '../src/modules/dashboard/portfolio.service.ts';

/**
 * The portfolio risk score is pure arithmetic over counters, so it is tested
 * without a database.
 *
 *   npm run test:portfolio
 */

const NOW = new Date('2026-10-14T12:00:00.000Z'); // a Wednesday

const stats = (over = {}) => ({
  totalTasks: 20,
  doneTasks: 10,
  openTasks: 10,
  overdueTasks: 0,
  blockedTasks: 0,
  unassignedTasks: 0,
  openIssues: 0,
  criticalIssues: 0,
  progress: 50,
  ...over,
});

const project = (over = {}) => ({
  status: 'ACTIVE',
  targetDate: null,
  completedAt: null,
  openHotfixes: 0,
  ...over,
  stats: stats(over.stats),
});

describe('assessRisk', () => {
  it('rates a clean project on track with no reasons', () => {
    const risk = assessRisk(project(), NOW);
    assert.equal(risk.level, 'ON_TRACK');
    assert.equal(risk.score, 0);
    assert.deepEqual(risk.reasons, []);
    assert.equal(risk.slipDays, null);
  });

  it('counts a passed target date as slip and explains it', () => {
    const risk = assessRisk(
      project({ targetDate: new Date('2026-09-14T00:00:00.000Z') }),
      NOW,
    );
    assert.equal(risk.slipDays, 30);
    assert.equal(risk.level, 'AT_RISK');
    assert.match(risk.reasons[0], /Target date passed 30 days ago/);
  });

  it('ignores a passed target date once the project is finished', () => {
    const risk = assessRisk(
      project({
        targetDate: new Date('2026-09-14T00:00:00.000Z'),
        completedAt: new Date('2026-09-10T00:00:00.000Z'),
      }),
      NOW,
    );
    assert.equal(risk.slipDays, null);
    assert.equal(risk.level, 'ON_TRACK');
  });

  it('flags a deadline that is close while the work is not nearly done', () => {
    const risk = assessRisk(
      project({ targetDate: new Date('2026-10-20T00:00:00.000Z') }),
      NOW,
    );
    assert.equal(risk.slipDays, null);
    assert.equal(risk.level, 'WATCH');
    assert.match(risk.reasons[0], /Due in 6 days at 50% complete/);
  });

  it('stays quiet about a close deadline when the project is nearly done', () => {
    const risk = assessRisk(
      project({
        targetDate: new Date('2026-10-20T00:00:00.000Z'),
        stats: { doneTasks: 19, openTasks: 1, progress: 95 },
      }),
      NOW,
    );
    assert.deepEqual(risk.reasons, []);
  });

  it('escalates to critical when several signals stack up', () => {
    const risk = assessRisk(
      project({
        targetDate: new Date('2026-08-14T00:00:00.000Z'),
        openHotfixes: 2,
        stats: { overdueTasks: 8, blockedTasks: 4, criticalIssues: 3, openTasks: 10 },
      }),
      NOW,
    );
    assert.equal(risk.level, 'CRITICAL');
    assert.ok(risk.reasons.length >= 4, 'every contributing signal is explained');
  });

  it('calls out a project where nobody is assigned anything', () => {
    const risk = assessRisk(
      project({ stats: { openTasks: 10, unassignedTasks: 10 } }),
      NOW,
    );
    assert.ok(risk.reasons.includes('Every open task is unassigned.'));
  });

  it('says an empty project is unstarted rather than healthy', () => {
    const risk = assessRisk(
      project({ stats: { totalTasks: 0, doneTasks: 0, openTasks: 0, progress: 0 } }),
      NOW,
    );
    assert.equal(risk.score, 0);
    assert.ok(risk.reasons.includes('No tasks have been created yet.'));
  });

  it('never divides by zero when there is no open work', () => {
    const risk = assessRisk(
      project({ stats: { openTasks: 0, overdueTasks: 0, blockedTasks: 3 } }),
      NOW,
    );
    assert.ok(Number.isFinite(risk.score));
  });
});

describe('byRisk', () => {
  it('sorts worst level first, then by score', () => {
    const rows = [
      { name: 'a', risk: { level: 'WATCH', score: 20 } },
      { name: 'b', risk: { level: 'CRITICAL', score: 61 } },
      { name: 'c', risk: { level: 'ON_TRACK', score: 0 } },
      { name: 'd', risk: { level: 'CRITICAL', score: 95 } },
      { name: 'e', risk: { level: 'AT_RISK', score: 40 } },
    ];
    assert.deepEqual([...rows].sort(byRisk).map((r) => r.name), ['d', 'b', 'e', 'a', 'c']);
  });
});

describe('week bucketing', () => {
  it('snaps a Wednesday back to its Monday', () => {
    assert.equal(mondayOf(NOW).toISOString().slice(0, 10), '2026-10-12');
  });

  it('treats Sunday as the end of the week that began on Monday', () => {
    const sunday = new Date('2026-10-18T23:30:00.000Z');
    assert.equal(mondayOf(sunday).toISOString().slice(0, 10), '2026-10-12');
  });

  it('keeps Monday on itself', () => {
    const monday = new Date('2026-10-12T00:00:00.000Z');
    assert.equal(mondayOf(monday).toISOString().slice(0, 10), '2026-10-12');
  });

  it('returns a gap-free series of Mondays, oldest first', () => {
    const buckets = weekBuckets(4, NOW);
    assert.deepEqual(buckets, ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
  });
});
