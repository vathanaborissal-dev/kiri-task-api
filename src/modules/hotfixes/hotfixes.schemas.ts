import { z } from 'zod';
import { csvArray, optionalDate, paginationSchema } from '../../lib/http.js';

export const HOTFIX_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'IN_PROGRESS',
  'IN_TESTING',
  'READY',
  'DEPLOYED',
  'VERIFIED',
  'REJECTED',
] as const;

const SEVERITIES = ['MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'] as const;
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export const listHotfixesQuery = paginationSchema.extend({
  projectId: z.string().optional(),
  status: csvArray,
  severity: csvArray,
  assigneeId: csvArray,
  openOnly: z.coerce.boolean().default(false),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(['createdAt', 'dueDate', 'severity', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const createHotfixSchema = z.object({
  projectId: z.string().min(1, 'Choose a project'),
  title: z.string().trim().min(4, 'Summarise the problem').max(300),
  description: z.string().max(20000).nullish(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  issueId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  releaseId: z.string().nullish(),
  dueDate: optionalDate,
  /** Create and link a task to carry the fix. */
  createTask: z.boolean().default(true),
});

export const updateHotfixSchema = z.object({
  title: z.string().trim().min(4).max(300).optional(),
  description: z.string().max(20000).nullish(),
  severity: z.enum(SEVERITIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(HOTFIX_STATUSES).optional(),
  issueId: z.string().nullish(),
  taskId: z.string().nullish(),
  releaseId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  dueDate: optionalDate,
  rootCause: z.string().max(5000).nullish(),
  resolution: z.string().max(5000).nullish(),
});

export const decisionSchema = z.object({
  approve: z.boolean(),
  comment: z.string().max(2000).trim().optional(),
});
