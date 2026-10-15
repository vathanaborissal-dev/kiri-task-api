import type { Request, Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { HotfixStatus, IssueStatus } from '../../generated/prisma/enums.js';
import { getAuth } from '../../middleware/auth.js';
import { q } from '../../middleware/validate.js';
import { progressForProjects } from '../projects/projects.service.js';
import { phaseSummary, userSummary } from '../shared/selectors.js';
import { shapeTask, taskListSelect } from '../tasks/tasks.service.js';
import {
  assessRisk,
  byRisk,
  mondayOf,
  weekBuckets,
  type RiskLevel,
} from './portfolio.service.js';

const OPEN_ISSUE_STATUSES: IssueStatus[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'READY_FOR_TESTING',
  'REOPENED',
];
const OPEN_HOTFIX_STATUSES: HotfixStatus[] = [
  'REQUESTED',
  'APPROVED',
  'IN_PROGRESS',
  'IN_TESTING',
  'READY',
];

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

const EMPTY_PORTFOLIO_TOTALS = {
  projects: 0,
  activeProjects: 0,
  tasks: 0,
  openTasks: 0,
  doneTasks: 0,
  overdueTasks: 0,
  unassignedTasks: 0,
  blockedTasks: 0,
  openIssues: 0,
  criticalIssues: 0,
  openHotfixes: 0,
  progress: 0,
};

/** The manager view: everything across every project the caller can see. */
export const getOverview = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const projectIds = await auth.accessibleProjectIds();

  if (projectIds.length === 0) {
    res.json({
      data: {
        totals: {
          projects: 0,
          activeProjects: 0,
          tasks: 0,
          openTasks: 0,
          doneTasks: 0,
          overdueTasks: 0,
          unassignedTasks: 0,
          blockedTasks: 0,
          openIssues: 0,
          criticalIssues: 0,
          openHotfixes: 0,
          dueThisWeek: 0,
          progress: 0,
        },
        projects: [],
        phases: [],
        upcomingDeadlines: [],
        overdue: [],
        recentActivity: [],
        releases: [],
      },
    });
    return;
  }

  const now = new Date();

  const [
    projects,
    openIssues,
    criticalIssues,
    openHotfixes,
    dueThisWeek,
    upcomingDeadlines,
    overdue,
    recentActivity,
    releases,
    phaseRows,
  ] = await Promise.all([
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true,
        key: true,
        name: true,
        color: true,
        status: true,
        targetDate: true,
        archivedAt: true,
        owner: { select: userSummary },
        _count: { select: { members: true } },
      },
      orderBy: { name: 'asc' },
    }),
    prisma.issue.count({
      where: { projectId: { in: projectIds }, status: { in: OPEN_ISSUE_STATUSES } },
    }),
    prisma.issue.count({
      where: {
        projectId: { in: projectIds },
        status: { in: OPEN_ISSUE_STATUSES },
        severity: { in: ['CRITICAL', 'BLOCKER'] },
      },
    }),
    prisma.hotfix.count({
      where: { projectId: { in: projectIds }, status: { in: OPEN_HOTFIX_STATUSES } },
    }),
    prisma.task.count({
      where: {
        projectId: { in: projectIds },
        dueDate: { gte: now, lte: days(7) },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
    }),
    prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        dueDate: { gte: now, lte: days(14) },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
      orderBy: { dueDate: 'asc' },
      take: 15,
      select: taskListSelect,
    }),
    prisma.task.findMany({
      where: {
        projectId: { in: projectIds },
        dueDate: { lt: now },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
      orderBy: { dueDate: 'asc' },
      take: 15,
      select: taskListSelect,
    }),
    prisma.activityLog.findMany({
      where: { projectId: { in: projectIds } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        action: true,
        entityType: true,
        meta: true,
        createdAt: true,
        actor: { select: userSummary },
        project: { select: { id: true, key: true, name: true, color: true } },
        task: { select: { id: true, key: true, title: true } },
        issue: { select: { id: true, key: true, title: true } },
        hotfix: { select: { id: true, key: true, title: true } },
        release: { select: { id: true, version: true } },
      },
    }),
    prisma.release.findMany({
      where: { projectId: { in: projectIds }, status: { notIn: ['RELEASED', 'CANCELED'] } },
      orderBy: [{ plannedDate: { sort: 'asc', nulls: 'last' } }],
      take: 10,
      select: {
        id: true,
        version: true,
        name: true,
        status: true,
        isHotfix: true,
        plannedDate: true,
        project: { select: { id: true, key: true, name: true, color: true } },
        phase: { select: phaseSummary },
        _count: { select: { tasks: true, issues: true } },
      },
    }),
    prisma.task.groupBy({
      by: ['phaseId'],
      where: {
        projectId: { in: projectIds },
        status: { category: { notIn: ['CANCELED'] } },
      },
      _count: { _all: true },
    }),
  ]);

  const stats = await progressForProjects(projectIds);

  const totals = [...stats.values()].reduce(
    (acc, s) => ({
      tasks: acc.tasks + s.totalTasks,
      openTasks: acc.openTasks + s.openTasks,
      doneTasks: acc.doneTasks + s.doneTasks,
      overdueTasks: acc.overdueTasks + s.overdueTasks,
      unassignedTasks: acc.unassignedTasks + s.unassignedTasks,
      blockedTasks: acc.blockedTasks + s.blockedTasks,
    }),
    { tasks: 0, openTasks: 0, doneTasks: 0, overdueTasks: 0, unassignedTasks: 0, blockedTasks: 0 },
  );

  const phases = await prisma.projectPhase.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true, name: true, key: true, color: true, order: true },
  });
  const phaseCounts = new Map(phaseRows.map((r) => [r.phaseId ?? 'none', r._count._all]));
  const phaseSummaryByName = new Map<string, { name: string; color: string; order: number; count: number }>();
  for (const phase of phases) {
    const entry = phaseSummaryByName.get(phase.key) ?? {
      name: phase.name,
      color: phase.color,
      order: phase.order,
      count: 0,
    };
    entry.count += phaseCounts.get(phase.id) ?? 0;
    phaseSummaryByName.set(phase.key, entry);
  }

  res.json({
    data: {
      totals: {
        projects: projects.length,
        activeProjects: projects.filter((p) => p.status === 'ACTIVE').length,
        ...totals,
        openIssues,
        criticalIssues,
        openHotfixes,
        dueThisWeek,
        progress:
          totals.tasks > 0 ? Math.round((totals.doneTasks / totals.tasks) * 100) : 0,
      },
      projects: projects.map(({ _count, ...p }) => ({
        ...p,
        memberCount: _count.members,
        stats: stats.get(p.id)!,
      })),
      phases: [...phaseSummaryByName.values()]
        .sort((a, b) => a.order - b.order)
        .map(({ order, ...rest }) => rest),
      upcomingDeadlines: upcomingDeadlines.map(shapeTask),
      overdue: overdue.map(shapeTask),
      recentActivity,
      releases: releases.map(({ _count, ...r }) => ({
        ...r,
        counts: { tasks: _count.tasks, issues: _count.issues },
      })),
    },
  });
};

/** The individual view: what this person needs to do next. */
export const getMyWork = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const projectIds = await auth.accessibleProjectIds();
  const now = new Date();

  if (projectIds.length === 0) {
    res.json({
      data: {
        counts: { assigned: 0, inProgress: 0, dueToday: 0, dueThisWeek: 0, overdue: 0, blocked: 0, issues: 0, hotfixes: 0, reported: 0 },
        tasks: [],
        issues: [],
        hotfixes: [],
        reportedIssues: [],
        recentActivity: [],
      },
    });
    return;
  }

  const assignedToMe: Prisma.TaskWhereInput = {
    projectId: { in: projectIds },
    assignees: { some: { userId: auth.id } },
    status: { category: { notIn: ['DONE', 'CANCELED'] } },
  };

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  const [tasks, issues, hotfixes, reportedIssues, recentActivity, counts] = await Promise.all([
    prisma.task.findMany({
      where: assignedToMe,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }],
      take: 100,
      select: taskListSelect,
    }),
    prisma.issue.findMany({
      where: {
        projectId: { in: projectIds },
        assigneeId: auth.id,
        status: { in: OPEN_ISSUE_STATUSES },
      },
      orderBy: [{ severity: 'desc' }, { dueDate: { sort: 'asc', nulls: 'last' } }],
      take: 50,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        severity: true,
        priority: true,
        dueDate: true,
        project: { select: { id: true, key: true, name: true, color: true } },
        phase: { select: phaseSummary },
      },
    }),
    prisma.hotfix.findMany({
      where: {
        projectId: { in: projectIds },
        assigneeId: auth.id,
        status: { in: OPEN_HOTFIX_STATUSES },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        severity: true,
        dueDate: true,
        project: { select: { id: true, key: true, name: true, color: true } },
      },
    }),
    prisma.issue.findMany({
      where: {
        projectId: { in: projectIds },
        reporterId: auth.id,
        status: { in: OPEN_ISSUE_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        severity: true,
        project: { select: { id: true, key: true, name: true, color: true } },
        assignee: { select: userSummary },
      },
    }),
    prisma.activityLog.findMany({
      where: { projectId: { in: projectIds }, actorId: auth.id },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: {
        id: true,
        action: true,
        entityType: true,
        meta: true,
        createdAt: true,
        // Without the actor the feed rendered every line as "Someone" — on a
        // page that only ever lists this user's own activity.
        actor: { select: userSummary },
        project: { select: { id: true, key: true, name: true, color: true } },
        task: { select: { id: true, key: true, title: true } },
        issue: { select: { id: true, key: true, title: true } },
        hotfix: { select: { id: true, key: true, title: true } },
        release: { select: { id: true, version: true } },
      },
    }),
    Promise.all([
      prisma.task.count({ where: assignedToMe }),
      prisma.task.count({
        where: { ...assignedToMe, status: { category: 'IN_PROGRESS' } },
      }),
      prisma.task.count({
        where: { ...assignedToMe, dueDate: { gte: startOfDay, lte: endOfDay } },
      }),
      prisma.task.count({ where: { ...assignedToMe, dueDate: { gte: now, lte: days(7) } } }),
      prisma.task.count({ where: { ...assignedToMe, dueDate: { lt: now } } }),
      prisma.task.count({ where: { ...assignedToMe, status: { category: 'BLOCKED' } } }),
    ]),
  ]);

  const [assigned, inProgress, dueToday, dueThisWeek, overdue, blocked] = counts;

  res.json({
    data: {
      counts: {
        assigned,
        inProgress,
        dueToday,
        dueThisWeek,
        overdue,
        blocked,
        issues: issues.length,
        hotfixes: hotfixes.length,
        reported: reportedIssues.length,
      },
      tasks: tasks.map(shapeTask),
      issues,
      hotfixes,
      reportedIssues,
      recentActivity,
    },
  });
};

/** Per-project report: progress, phases, workload, QA and release readiness. */
export const getProjectReport = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  const access = await auth.requireProject(String(req.params.projectId), 'report:view');
  const projectId = access.projectId;
  const now = new Date();

  const [project, stats, statusRows, priorityRows, typeRows, qaRows, phases, phaseRows, issueRows, members, milestones, releases, velocity] =
    await Promise.all([
      prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: {
          id: true,
          key: true,
          name: true,
          description: true,
          color: true,
          status: true,
          startDate: true,
          targetDate: true,
          completedAt: true,
          owner: { select: userSummary },
        },
      }),
      progressForProjects([projectId]),
      prisma.task.groupBy({
        by: ['statusId'],
        where: { projectId },
        _count: { _all: true },
      }),
      prisma.task.groupBy({
        by: ['priority'],
        where: { projectId, status: { category: { notIn: ['DONE', 'CANCELED'] } } },
        _count: { _all: true },
      }),
      prisma.task.groupBy({ by: ['type'], where: { projectId }, _count: { _all: true } }),
      prisma.task.groupBy({ by: ['qaStatus'], where: { projectId }, _count: { _all: true } }),
      prisma.projectPhase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      prisma.task.groupBy({ by: ['phaseId'], where: { projectId }, _count: { _all: true } }),
      prisma.issue.groupBy({
        by: ['status', 'severity'],
        where: { projectId },
        _count: { _all: true },
      }),
      prisma.projectMember.findMany({
        where: { projectId },
        select: {
          responsibilities: true,
          user: { select: userSummary },
          role: { select: { id: true, name: true } },
        },
        orderBy: { user: { name: 'asc' } },
      }),
      prisma.milestone.findMany({
        where: { projectId },
        orderBy: [{ dueDate: 'asc' }],
        select: {
          id: true,
          name: true,
          dueDate: true,
          completedAt: true,
          _count: { select: { tasks: true } },
        },
      }),
      prisma.release.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          version: true,
          status: true,
          isHotfix: true,
          plannedDate: true,
          releasedAt: true,
          phase: { select: phaseSummary },
          _count: { select: { tasks: true, issues: true, deployments: true } },
        },
      }),
      prisma.task.findMany({
        where: { projectId, completedAt: { gte: new Date(Date.now() - 56 * 24 * 60 * 60 * 1000) } },
        select: { completedAt: true, estimateHours: true },
      }),
    ]);

  const statuses = await prisma.taskStatus.findMany({
    where: { projectId },
    orderBy: { order: 'asc' },
  });
  const statusCounts = new Map(statusRows.map((r) => [r.statusId, r._count._all]));

  const phaseCounts = new Map(phaseRows.map((r) => [r.phaseId ?? 'none', r._count._all]));

  const taskAssignments = await prisma.taskAssignee.groupBy({
    by: ['userId'],
    where: { task: { projectId, status: { category: { notIn: ['DONE', 'CANCELED'] } } } },
    _count: { _all: true },
  });
  const overdueByUser = await prisma.taskAssignee.groupBy({
    by: ['userId'],
    where: {
      task: {
        projectId,
        dueDate: { lt: now },
        status: { category: { notIn: ['DONE', 'CANCELED'] } },
      },
    },
    _count: { _all: true },
  });
  const openByUser = new Map(taskAssignments.map((r) => [r.userId, r._count._all]));
  const lateByUser = new Map(overdueByUser.map((r) => [r.userId, r._count._all]));

  // The report never sent this, so every milestone read "0 of N done" however
  // much of it had shipped.
  const doneRows = await prisma.task.groupBy({
    by: ['milestoneId'],
    where: { projectId, milestoneId: { not: null }, status: { category: 'DONE' } },
    _count: { _all: true },
  });
  const doneByMilestone = new Map(doneRows.map((row) => [row.milestoneId, row._count._all]));

  // Weekly throughput for the last 8 weeks. Every week is seeded at zero first:
  // a week nobody finished anything is a real data point, and dropping it made
  // the chart close the gap and imply steady delivery.
  const mondayOf = (date: Date) => {
    const monday = new Date(date);
    monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return monday;
  };

  const weeks = new Map<string, number>();
  const thisMonday = mondayOf(new Date());
  for (let back = 7; back >= 0; back -= 1) {
    const monday = new Date(thisMonday);
    monday.setDate(thisMonday.getDate() - back * 7);
    weeks.set(monday.toISOString().slice(0, 10), 0);
  }

  for (const task of velocity) {
    if (!task.completedAt) continue;
    const key = mondayOf(new Date(task.completedAt)).toISOString().slice(0, 10);
    if (weeks.has(key)) weeks.set(key, weeks.get(key)! + 1);
  }

  res.json({
    data: {
      project,
      stats: stats.get(projectId)!,
      statusBreakdown: statuses.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        color: s.color,
        count: statusCounts.get(s.id) ?? 0,
      })),
      priorityBreakdown: priorityRows.map((r) => ({ priority: r.priority, count: r._count._all })),
      typeBreakdown: typeRows.map((r) => ({ type: r.type, count: r._count._all })),
      qaBreakdown: qaRows.map((r) => ({ qaStatus: r.qaStatus, count: r._count._all })),
      phaseBreakdown: [
        ...phases.map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color,
          isProduction: p.isProduction,
          count: phaseCounts.get(p.id) ?? 0,
        })),
        { id: 'none', name: 'Not started', color: '#94a3b8', isProduction: false, count: phaseCounts.get('none') ?? 0 },
      ],
      issueBreakdown: issueRows.map((r) => ({
        status: r.status,
        severity: r.severity,
        count: r._count._all,
      })),
      workload: members.map((m) => ({
        ...m.user,
        role: m.role,
        responsibilities: m.responsibilities,
        openTasks: openByUser.get(m.user.id) ?? 0,
        overdueTasks: lateByUser.get(m.user.id) ?? 0,
      })),
      milestones: milestones.map(({ _count, ...m }) => ({
        ...m,
        taskCount: _count.tasks,
        doneTaskCount: doneByMilestone.get(m.id) ?? 0,
      })),
      releases: releases.map(({ _count, ...r }) => ({
        ...r,
        counts: { tasks: _count.tasks, issues: _count.issues, deployments: _count.deployments },
      })),
      velocity: [...weeks.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, completed]) => ({ week, completed })),
    },
  });
};

/**
 * The portfolio view: every project ranked by how much trouble it is in, plus
 * an org-wide delivery trend.
 *
 * Separate from `getOverview` because the audience is different. The overview
 * answers "what should I look at today"; this answers "which of these twenty
 * projects should I be worried about", which needs ranking and a time axis
 * rather than a longer list of counters.
 */
export const getPortfolio = async (req: Request, res: Response) => {
  const auth = getAuth(req);
  auth.assert('project:view_all');
  auth.assert('report:view');

  const query = q<{ weeks: number; includeArchived: boolean }>(req);
  const now = new Date();

  const projectWhere: Prisma.ProjectWhereInput = query.includeArchived
    ? {}
    : { archivedAt: null, status: { not: 'ARCHIVED' } };

  const projects = await prisma.project.findMany({
    where: projectWhere,
    select: {
      id: true,
      key: true,
      name: true,
      color: true,
      status: true,
      startDate: true,
      targetDate: true,
      completedAt: true,
      archivedAt: true,
      owner: { select: userSummary },
      _count: { select: { members: true } },
    },
    orderBy: { name: 'asc' },
  });

  const projectIds = projects.map((p) => p.id);

  if (projectIds.length === 0) {
    res.json({
      data: {
        totals: EMPTY_PORTFOLIO_TOTALS,
        projects: [],
        attention: [],
        trend: weekBuckets(query.weeks, now).map((week) => ({
          week,
          completed: 0,
          created: 0,
          estimateCompleted: 0,
        })),
        capacity: [],
        riskCounts: { ON_TRACK: 0, WATCH: 0, AT_RISK: 0, CRITICAL: 0 },
        includesArchived: query.includeArchived,
      },
    });
    return;
  }

  const trendFrom = new Date(`${weekBuckets(query.weeks, now)[0]}T00:00:00.000Z`);

  const [stats, hotfixRows, openIssues, criticalIssues, completedRows, createdRows, capacityRows] =
    await Promise.all([
      progressForProjects(projectIds),
      prisma.hotfix.groupBy({
        by: ['projectId'],
        where: { projectId: { in: projectIds }, status: { in: OPEN_HOTFIX_STATUSES } },
        _count: { _all: true },
      }),
      prisma.issue.count({
        where: { projectId: { in: projectIds }, status: { in: OPEN_ISSUE_STATUSES } },
      }),
      prisma.issue.count({
        where: {
          projectId: { in: projectIds },
          status: { in: OPEN_ISSUE_STATUSES },
          severity: { in: ['CRITICAL', 'BLOCKER'] },
        },
      }),
      prisma.task.findMany({
        where: {
          projectId: { in: projectIds },
          parentTaskId: null,
          completedAt: { gte: trendFrom },
        },
        select: { completedAt: true, estimateHours: true },
      }),
      prisma.task.findMany({
        where: { projectId: { in: projectIds }, parentTaskId: null, createdAt: { gte: trendFrom } },
        select: { createdAt: true },
      }),
      prisma.taskAssignee.findMany({
        where: {
          task: {
            projectId: { in: projectIds },
            status: { category: { notIn: ['DONE', 'CANCELED'] } },
          },
        },
        select: {
          user: { select: userSummary },
          task: { select: { dueDate: true, status: { select: { category: true } } } },
        },
      }),
    ]);

  const hotfixes = new Map(hotfixRows.map((r) => [r.projectId, r._count._all]));

  const ranked = projects
    .map(({ _count, ...project }) => {
      const projectStats = stats.get(project.id)!;
      return {
        ...project,
        memberCount: _count.members,
        stats: projectStats,
        openHotfixes: hotfixes.get(project.id) ?? 0,
        risk: assessRisk(
          {
            status: project.status,
            targetDate: project.targetDate,
            completedAt: project.completedAt,
            stats: projectStats,
            openHotfixes: hotfixes.get(project.id) ?? 0,
          },
          now,
        ),
      };
    })
    .sort(byRisk);

  const totals = [...stats.values()].reduce(
    (acc, s) => ({
      tasks: acc.tasks + s.totalTasks,
      openTasks: acc.openTasks + s.openTasks,
      doneTasks: acc.doneTasks + s.doneTasks,
      overdueTasks: acc.overdueTasks + s.overdueTasks,
      unassignedTasks: acc.unassignedTasks + s.unassignedTasks,
      blockedTasks: acc.blockedTasks + s.blockedTasks,
    }),
    { tasks: 0, openTasks: 0, doneTasks: 0, overdueTasks: 0, unassignedTasks: 0, blockedTasks: 0 },
  );

  // --- Weekly delivery trend ------------------------------------------------
  const buckets = weekBuckets(query.weeks, now);
  const trend = new Map(
    buckets.map((week) => [week, { week, completed: 0, created: 0, estimateCompleted: 0 }]),
  );
  for (const task of completedRows) {
    if (!task.completedAt) continue;
    const bucket = trend.get(mondayOf(task.completedAt).toISOString().slice(0, 10));
    if (!bucket) continue;
    bucket.completed += 1;
    bucket.estimateCompleted += task.estimateHours ?? 0;
  }
  for (const task of createdRows) {
    const bucket = trend.get(mondayOf(task.createdAt).toISOString().slice(0, 10));
    if (bucket) bucket.created += 1;
  }

  // --- Capacity -------------------------------------------------------------
  const capacity = new Map<
    string,
    { user: (typeof capacityRows)[number]['user']; openTasks: number; overdueTasks: number; blockedTasks: number }
  >();
  for (const row of capacityRows) {
    const entry =
      capacity.get(row.user.id) ??
      { user: row.user, openTasks: 0, overdueTasks: 0, blockedTasks: 0 };
    entry.openTasks += 1;
    if (row.task.dueDate && row.task.dueDate < now) entry.overdueTasks += 1;
    if (row.task.status.category === 'BLOCKED') entry.blockedTasks += 1;
    capacity.set(row.user.id, entry);
  }

  const riskCounts = ranked.reduce(
    (acc, project) => ({ ...acc, [project.risk.level]: acc[project.risk.level] + 1 }),
    { ON_TRACK: 0, WATCH: 0, AT_RISK: 0, CRITICAL: 0 } as Record<RiskLevel, number>,
  );

  res.json({
    data: {
      totals: {
        projects: projects.length,
        activeProjects: projects.filter((p) => p.status === 'ACTIVE').length,
        ...totals,
        openIssues,
        criticalIssues,
        openHotfixes: [...hotfixes.values()].reduce((a, b) => a + b, 0),
        progress: totals.tasks > 0 ? Math.round((totals.doneTasks / totals.tasks) * 100) : 0,
      },
      projects: ranked,
      // The short list somebody actually acts on, so the client does not have
      // to re-implement the threshold.
      attention: ranked
        .filter((p) => p.risk.level === 'CRITICAL' || p.risk.level === 'AT_RISK')
        .slice(0, 8)
        .map((p) => ({ id: p.id, key: p.key, name: p.name, color: p.color, risk: p.risk })),
      trend: buckets.map((week) => trend.get(week)!),
      capacity: [...capacity.values()].sort((a, b) => b.openTasks - a.openTasks).slice(0, 12),
      riskCounts,
      includesArchived: query.includeArchived,
    },
  });
};
