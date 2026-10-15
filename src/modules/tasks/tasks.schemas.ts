import { z } from 'zod';
import { csvArray, optionalDate, paginationSchema } from '../../lib/http.js';

export const TASK_TYPES = ['TASK', 'FEATURE', 'BUG', 'IMPROVEMENT', 'CHORE', 'HOTFIX'] as const;
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const QA_STATUSES = ['NOT_REQUIRED', 'PENDING', 'IN_TESTING', 'PASSED', 'FAILED'] as const;
export const STATUS_CATEGORIES = [
  'TODO',
  'IN_PROGRESS',
  'IN_REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELED',
] as const;

export const listTasksQuery = paginationSchema.extend({
  projectId: z.string().optional(),
  search: z.string().trim().max(200).optional(),
  statusId: csvArray,
  statusCategory: csvArray,
  priority: csvArray,
  type: csvArray,
  qaStatus: csvArray,
  phaseId: csvArray,
  assigneeId: csvArray,
  reporterId: z.string().optional(),
  labelId: csvArray,
  milestoneId: z.string().optional(),
  releaseId: z.string().optional(),
  parentTaskId: z.string().optional(),
  /** `true` hides subtasks from flat lists. */
  topLevelOnly: z.coerce.boolean().default(false),
  unassigned: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(),
  dueFrom: optionalDate,
  dueTo: optionalDate,
  dueWithinDays: z.coerce.number().int().min(0).max(365).optional(),
  includeDone: z.coerce.boolean().default(true),
  sort: z
    .enum(['position', 'dueDate', 'priority', 'createdAt', 'updatedAt', 'title', 'key'])
    .default('position'),
  order: z.enum(['asc', 'desc']).default('asc'),
  groupBy: z.enum(['none', 'status', 'assignee', 'priority', 'phase', 'milestone']).default('none'),
});

export const createTaskSchema = z.object({
  projectId: z.string().min(1, 'Choose a project'),
  title: z.string().trim().min(2, 'Give the task a title').max(300),
  description: z.string().max(20000).nullish(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  statusId: z.string().optional(),
  phaseId: z.string().nullish(),
  qaStatus: z.enum(QA_STATUSES).optional(),
  parentTaskId: z.string().nullish(),
  milestoneId: z.string().nullish(),
  releaseId: z.string().nullish(),
  assigneeIds: z.array(z.string().min(1)).max(20).optional(),
  labelIds: z.array(z.string().min(1)).max(20).optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
  estimateHours: z.number().min(0).max(10000).nullish(),
  checklist: z.array(z.string().min(1).max(300)).max(50).optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().trim().min(2).max(300).optional(),
  description: z.string().max(20000).nullish(),
  type: z.enum(TASK_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  statusId: z.string().optional(),
  phaseId: z.string().nullish(),
  qaStatus: z.enum(QA_STATUSES).optional(),
  milestoneId: z.string().nullish(),
  releaseId: z.string().nullish(),
  parentTaskId: z.string().nullish(),
  startDate: optionalDate,
  dueDate: optionalDate,
  estimateHours: z.number().min(0).max(10000).nullish(),
  spentHours: z.number().min(0).max(10000).nullish(),
  labelIds: z.array(z.string().min(1)).max(20).optional(),
  assigneeIds: z.array(z.string().min(1)).max(20).optional(),
});

export const moveTaskSchema = z.object({
  statusId: z.string().min(1),
  /** Task to place this one after; omit or null to move to the top. */
  afterTaskId: z.string().nullish(),
});

export const assigneesSchema = z.object({
  userIds: z.array(z.string().min(1)).max(20),
});

export const checklistItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  assigneeId: z.string().nullish(),
  dueDate: optionalDate,
});

export const updateChecklistItemSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  isDone: z.boolean().optional(),
  assigneeId: z.string().nullish(),
  dueDate: optionalDate,
  order: z.number().int().min(0).optional(),
});

export const linkSchema = z.object({
  targetTaskId: z.string().min(1),
  type: z.enum([
    'BLOCKS',
    'BLOCKED_BY',
    'RELATES_TO',
    'DUPLICATES',
    'DUPLICATED_BY',
    'FIXES',
    'FIXED_BY',
  ]),
});

export const bulkUpdateSchema = z.object({
  taskIds: z.array(z.string().min(1)).min(1).max(200),
  statusId: z.string().optional(),
  priority: z.enum(PRIORITIES).optional(),
  phaseId: z.string().nullish(),
  qaStatus: z.enum(QA_STATUSES).optional(),
  milestoneId: z.string().nullish(),
  releaseId: z.string().nullish(),
  dueDate: optionalDate,
  addAssigneeIds: z.array(z.string().min(1)).max(20).optional(),
  removeAssigneeIds: z.array(z.string().min(1)).max(20).optional(),
  addLabelIds: z.array(z.string().min(1)).max(20).optional(),
  removeLabelIds: z.array(z.string().min(1)).max(20).optional(),
});
