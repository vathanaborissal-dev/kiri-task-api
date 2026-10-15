import type { ProgressSummary } from '../projects/projects.service.js';

export type RiskLevel = 'ON_TRACK' | 'WATCH' | 'AT_RISK' | 'CRITICAL';

export type RiskAssessment = {
  level: RiskLevel;
  score: number;
  /** Plain sentences, in the order they contributed. Never an opaque number. */
  reasons: string[];
  /** Days past `targetDate`, or null when there is no target or it is in the future. */
  slipDays: number | null;
};

export type PortfolioProjectInput = {
  status: string;
  targetDate: Date | null;
  completedAt: Date | null;
  stats: ProgressSummary;
  openHotfixes: number;
};

const LEVEL_ORDER: RiskLevel[] = ['ON_TRACK', 'WATCH', 'AT_RISK', 'CRITICAL'];

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

const dayDiff = (from: Date, to: Date) =>
  Math.floor((from.getTime() - to.getTime()) / (24 * 60 * 60 * 1000));

/**
 * Turns a project's counters into one ranked health signal.
 *
 * The weights are deliberately crude and the reasons are returned alongside the
 * score, because the number on its own is not an argument — somebody reading
 * "At risk" immediately asks why, and the answer has to be in the payload
 * rather than in whoever wrote the formula's head.
 */
export const assessRisk = (project: PortfolioProjectInput, now: Date): RiskAssessment => {
  const reasons: string[] = [];
  let score = 0;

  const { stats } = project;
  const openWork = Math.max(stats.openTasks, 1);

  // --- Deadline slip --------------------------------------------------------
  let slipDays: number | null = null;
  if (project.targetDate && !project.completedAt) {
    const slip = dayDiff(now, project.targetDate);
    if (slip > 0) {
      slipDays = slip;
      score += slip >= 30 ? 40 : slip >= 7 ? 28 : 16;
      reasons.push(
        `Target date passed ${slip} day${slip === 1 ? '' : 's'} ago with ${stats.openTasks} task${
          stats.openTasks === 1 ? '' : 's'
        } still open.`,
      );
    } else if (slip > -14 && stats.progress < 70) {
      // Close to the line and not nearly finished.
      score += 18;
      reasons.push(
        `Due in ${Math.abs(slip)} day${Math.abs(slip) === 1 ? '' : 's'} at ${stats.progress}% complete.`,
      );
    }
  }

  // --- Overdue work --------------------------------------------------------
  if (stats.overdueTasks > 0) {
    const share = pct(stats.overdueTasks, openWork);
    score += share >= 40 ? 30 : share >= 15 ? 20 : 10;
    reasons.push(
      `${stats.overdueTasks} overdue task${stats.overdueTasks === 1 ? '' : 's'} (${Math.round(
        share,
      )}% of open work).`,
    );
  }

  // --- Blocked work --------------------------------------------------------
  if (stats.blockedTasks > 0) {
    const share = pct(stats.blockedTasks, openWork);
    score += share >= 25 ? 20 : 10;
    reasons.push(
      `${stats.blockedTasks} blocked task${stats.blockedTasks === 1 ? '' : 's'} waiting on something.`,
    );
  }

  // --- Quality signals -----------------------------------------------------
  if (stats.criticalIssues > 0) {
    score += stats.criticalIssues >= 3 ? 25 : 14;
    reasons.push(
      `${stats.criticalIssues} critical or blocker issue${stats.criticalIssues === 1 ? '' : 's'} open.`,
    );
  }
  if (project.openHotfixes > 0) {
    score += 12;
    reasons.push(
      `${project.openHotfixes} hotfix${project.openHotfixes === 1 ? '' : 'es'} in flight.`,
    );
  }

  // --- Nobody on it --------------------------------------------------------
  if (stats.openTasks > 0 && stats.unassignedTasks === stats.openTasks) {
    score += 15;
    reasons.push('Every open task is unassigned.');
  } else if (pct(stats.unassignedTasks, openWork) >= 50) {
    score += 8;
    reasons.push(`${stats.unassignedTasks} of ${stats.openTasks} open tasks have nobody on them.`);
  }

  // --- Stalled -------------------------------------------------------------
  if (project.status === 'ON_HOLD') {
    score += 10;
    reasons.push('Project is on hold.');
  }

  // A project with no tasks at all is not healthy, it is unstarted — say so
  // rather than scoring it a perfect zero next to genuinely finished work.
  if (stats.totalTasks === 0) {
    reasons.push('No tasks have been created yet.');
  }

  const level: RiskLevel =
    score >= 60 ? 'CRITICAL' : score >= 35 ? 'AT_RISK' : score >= 15 ? 'WATCH' : 'ON_TRACK';

  return { level, score, reasons, slipDays };
};

/** Sorts worst-first, then by score, so the ranking is stable. */
export const byRisk = (
  a: { risk: RiskAssessment },
  b: { risk: RiskAssessment },
): number =>
  LEVEL_ORDER.indexOf(b.risk.level) - LEVEL_ORDER.indexOf(a.risk.level) ||
  b.risk.score - a.risk.score;

/** Monday 00:00 of the week containing `date`, in UTC. */
export const mondayOf = (date: Date): Date => {
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay(): 0 = Sunday, so Sunday belongs to the week that began 6 days ago.
  const offset = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - offset);
  return monday;
};

/** An ordered, gap-free series of the last `weeks` Mondays, oldest first. */
export const weekBuckets = (weeks: number, now: Date): string[] => {
  const current = mondayOf(now);
  const keys: string[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const monday = new Date(current);
    monday.setUTCDate(monday.getUTCDate() - i * 7);
    keys.push(monday.toISOString().slice(0, 10));
  }
  return keys;
};
