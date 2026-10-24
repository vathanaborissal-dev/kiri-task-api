/**
 * The issue workflow: which status can follow which, and who is allowed to make
 * each move.
 *
 * Two rules drive the table:
 *
 *  1. **No going back down.** Once an issue has settled — RESOLVED, CLOSED or
 *     WONT_FIX — the only way back into the active workflow is REOPENED. Work
 *     cannot quietly slide from CLOSED back to IN_PROGRESS, because the reopen
 *     count and the reopen notification are how the team learns a fix did not
 *     hold. The same applies inside the active workflow: IN_PROGRESS does not
 *     drop back to OPEN or ASSIGNED, since that would erase the fact that
 *     somebody had picked the issue up.
 *
 *     The one regression that *is* allowed is READY_FOR_TESTING → IN_PROGRESS.
 *     That is not a step backwards, it is testing reporting a failure, and
 *     forcing a reopen for it would inflate the reopen count on every QA cycle.
 *
 *  2. **The sharp edges need a permission.** Taking an issue is open to anybody
 *     who can change status; handing it to someone else, closing it and
 *     reopening it are not. The permission is named per transition rather than
 *     per status so the table itself is the documentation — `transitionTable()`
 *     renders it for the UI.
 */

import type { IssueStatus } from '../../generated/prisma/enums.js';

export const ISSUE_STATUS_LABEL: Record<IssueStatus, string> = {
  OPEN: 'Open',
  ASSIGNED: 'Assigned',
  IN_PROGRESS: 'In Progress',
  READY_FOR_TESTING: 'Ready for Testing',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  WONT_FIX: "Won't Fix",
};

/** Statuses an issue can still be worked on from. */
export const ACTIVE_ISSUE_STATUSES: IssueStatus[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'READY_FOR_TESTING',
  'REOPENED',
];

/** Statuses that count as finished — reachable again only through REOPENED. */
export const SETTLED_ISSUE_STATUSES: IssueStatus[] = ['RESOLVED', 'CLOSED', 'WONT_FIX'];

export const isSettled = (status: IssueStatus) => SETTLED_ISSUE_STATUSES.includes(status);

export type Transition = {
  to: IssueStatus;
  /** Permission the actor needs on the project, on top of `issue:change_status`. */
  requires?: 'issue:assign' | 'issue:close' | 'issue:reopen';
  /** Shown in the role matrix and in the refusal message. */
  note?: string;
};

const CLOSE_OUT: Transition[] = [
  { to: 'CLOSED', requires: 'issue:close', note: 'Closing an issue needs the close permission' },
  { to: 'WONT_FIX', requires: 'issue:close', note: 'Dismissing an issue needs the close permission' },
];

const REOPEN: Transition = {
  to: 'REOPENED',
  requires: 'issue:reopen',
  note: 'Reopening an issue needs the reopen permission',
};

export const ISSUE_TRANSITIONS: Record<IssueStatus, Transition[]> = {
  OPEN: [
    { to: 'ASSIGNED', requires: 'issue:assign', note: 'Assigning an issue needs the assign permission' },
    { to: 'IN_PROGRESS' },
    ...CLOSE_OUT,
  ],
  ASSIGNED: [
    { to: 'IN_PROGRESS' },
    { to: 'READY_FOR_TESTING' },
    ...CLOSE_OUT,
  ],
  IN_PROGRESS: [
    { to: 'READY_FOR_TESTING' },
    { to: 'RESOLVED' },
    ...CLOSE_OUT,
  ],
  // Testing failing is part of the loop, not a reopen.
  READY_FOR_TESTING: [
    { to: 'IN_PROGRESS', note: 'Testing failed — back to the developer' },
    { to: 'RESOLVED' },
    ...CLOSE_OUT,
  ],
  RESOLVED: [
    { to: 'CLOSED', requires: 'issue:close', note: 'Closing an issue needs the close permission' },
    REOPEN,
  ],
  CLOSED: [REOPEN],
  WONT_FIX: [REOPEN],
  REOPENED: [
    { to: 'ASSIGNED', requires: 'issue:assign', note: 'Assigning an issue needs the assign permission' },
    { to: 'IN_PROGRESS' },
    { to: 'READY_FOR_TESTING' },
    { to: 'RESOLVED' },
    ...CLOSE_OUT,
  ],
};

export const transitionFor = (from: IssueStatus, to: IssueStatus): Transition | undefined =>
  ISSUE_TRANSITIONS[from].find((transition) => transition.to === to);

export type TransitionRefusal = { code: 'NOT_ALLOWED' | 'NEEDS_PERMISSION'; message: string };

/**
 * Decides whether `from → to` may happen for an actor holding `permissions`.
 * Returns `null` when the move is fine.
 */
export const refuseTransition = (
  from: IssueStatus,
  to: IssueStatus,
  can: (permission: string) => boolean,
): TransitionRefusal | null => {
  if (from === to) return null;

  const transition = transitionFor(from, to);
  if (!transition) {
    // The most common mistake by far is trying to drag a finished issue back
    // into the workflow, so name the way out rather than just saying no.
    if (isSettled(from) && !isSettled(to)) {
      return {
        code: 'NOT_ALLOWED',
        message: `${ISSUE_STATUS_LABEL[from]} issues have to be reopened first — move it to Reopened, then to ${ISSUE_STATUS_LABEL[to]}.`,
      };
    }
    return {
      code: 'NOT_ALLOWED',
      message: `An issue cannot go from ${ISSUE_STATUS_LABEL[from]} straight to ${ISSUE_STATUS_LABEL[to]}.`,
    };
  }

  if (transition.requires && !can(transition.requires)) {
    return {
      code: 'NEEDS_PERMISSION',
      message: `${transition.note ?? 'You do not have permission for that move'} — ask a project manager, team lead or issue manager.`,
    };
  }

  return null;
};

/** The statuses this actor can move an issue to right now. */
export const allowedTransitions = (
  from: IssueStatus,
  can: (permission: string) => boolean,
): IssueStatus[] =>
  ISSUE_TRANSITIONS[from]
    .filter((transition) => !transition.requires || can(transition.requires))
    .map((transition) => transition.to);

/**
 * The whole table, flattened for the UI's "who can do what" matrix. Pure data —
 * no project context — so it can be served once and cached.
 */
export const transitionTable = () =>
  (Object.keys(ISSUE_TRANSITIONS) as IssueStatus[]).map((from) => ({
    from,
    fromLabel: ISSUE_STATUS_LABEL[from],
    settled: isSettled(from),
    to: ISSUE_TRANSITIONS[from].map((transition) => ({
      status: transition.to,
      label: ISSUE_STATUS_LABEL[transition.to],
      requires: transition.requires ?? null,
      note: transition.note ?? null,
    })),
  }));
