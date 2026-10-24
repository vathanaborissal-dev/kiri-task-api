import { z } from 'zod';
import { csvArray, optionalDate, paginationSchema } from '../../lib/http.js';

export const ISSUE_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'READY_FOR_TESTING',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'WONT_FIX',
] as const;

export const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export const listIssuesQuery = paginationSchema.extend({
  projectId: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  status: csvArray,
  severity: csvArray,
  priority: csvArray,
  phaseId: csvArray,
  assigneeId: csvArray,
  reporterId: z.string().optional(),
  labelId: csvArray,
  releaseId: z.string().optional(),
  unassigned: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  openOnly: z.coerce.boolean().default(false),
  hasTasks: z.coerce.boolean().optional(),
  sort: z
    .enum(['createdAt', 'updatedAt', 'severity', 'priority', 'dueDate', 'startDate', 'status'])
    .default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  groupBy: z.enum(['none', 'status', 'severity', 'assignee', 'phase']).default('none'),
});

export const createIssueSchema = z.object({
  projectId: z.string().min(1, 'Choose a project'),
  title: z.string().trim().min(4, 'Describe the problem in a short title').max(300),
  description: z.string().max(20000).nullish(),
  stepsToReproduce: z.string().max(10000).nullish(),
  expectedResult: z.string().max(5000).nullish(),
  actualResult: z.string().max(5000).nullish(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  phaseId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  taskId: z.string().nullish(),
  releaseId: z.string().nullish(),
  labelIds: z.array(z.string().min(1)).max(20).optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
});

export const updateIssueSchema = z.object({
  title: z.string().trim().min(4).max(300).optional(),
  description: z.string().max(20000).nullish(),
  stepsToReproduce: z.string().max(10000).nullish(),
  expectedResult: z.string().max(5000).nullish(),
  actualResult: z.string().max(5000).nullish(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  phaseId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  taskId: z.string().nullish(),
  releaseId: z.string().nullish(),
  labelIds: z.array(z.string().min(1)).max(20).optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
});

export const changeStatusSchema = z.object({
  status: z.enum(ISSUE_STATUSES),
  comment: z.string().max(5000).trim().optional(),
});

export const bulkUpdateIssuesSchema = z
  .object({
    issueIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(ISSUE_STATUSES).optional(),
    severity: z.enum(SEVERITIES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    phaseId: z.string().nullish(),
    assigneeId: z.string().nullish(),
    startDate: optionalDate,
    dueDate: optionalDate,
    addLabelIds: z.array(z.string().min(1)).max(20).optional(),
    removeLabelIds: z.array(z.string().min(1)).max(20).optional(),
  })
  .refine(
    (body) =>
      Object.keys(body).some((key) => key !== 'issueIds' && body[key as keyof typeof body] !== undefined),
    { message: 'Choose at least one thing to change' },
  );

/**
 * Body for raising another task against an issue.
 *
 * Everything is optional, and the whole body is too: this endpoint used to take
 * no body at all, and a client that still posts without one must keep working
 * rather than get a 422.
 */
export const createIssueTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(300).optional(),
    assigneeIds: z.array(z.string().min(1)).max(20).optional(),
    startDate: optionalDate,
    dueDate: optionalDate,
  })
  .default({ startDate: undefined, dueDate: undefined });
