import { z } from 'zod';
import { optionalDate, paginationSchema, queryBoolean } from '../../lib/http.js';

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #6366f1');

export const listProjectsQuery = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
  includeArchived: queryBoolean.default(false),
  sort: z.enum(['name', 'createdAt', 'targetDate', 'progress']).default('name'),
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(2, 'Give the project a name').max(120),
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'Use letters and numbers only, starting with a letter')
    .transform((v) => v.toUpperCase())
    .optional(),
  description: z.string().max(5000).trim().nullish(),
  color: hexColor.optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']).optional(),
  ownerId: z.string().min(1).optional(),
  startDate: optionalDate,
  targetDate: optionalDate,
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(5000).trim().nullish(),
  color: hexColor.optional(),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
  ownerId: z.string().min(1).optional(),
  startDate: optionalDate,
  targetDate: optionalDate,
});

export const addMemberSchema = z.object({
  userId: z.string().min(1, 'Choose a person'),
  roleId: z.string().min(1, 'Choose a project role'),
  responsibilities: z.string().max(1000).trim().nullish(),
});

export const updateMemberSchema = z.object({
  roleId: z.string().min(1).optional(),
  responsibilities: z.string().max(1000).trim().nullish(),
});

export const statusSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'BLOCKED', 'DONE', 'CANCELED']),
  color: hexColor.optional(),
  isDefault: z.boolean().optional(),
});

export const updateStatusSchema = statusSchema.partial();

export const phaseSchema = z.object({
  name: z.string().trim().min(1).max(40),
  description: z.string().max(500).trim().nullish(),
  color: hexColor.optional(),
  isProduction: z.boolean().optional(),
});

export const updatePhaseSchema = phaseSchema.partial();

export const reorderSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const labelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: hexColor.optional(),
});

export const milestoneSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).trim().nullish(),
  dueDate: optionalDate,
});

export const updateMilestoneSchema = milestoneSchema.partial().extend({
  completed: z.boolean().optional(),
});
